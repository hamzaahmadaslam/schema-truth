// Builds the requests (a page's visible text as the state, one yes/no question per claim), sends them to Jev, and
// turns each answer into a verdict: supported, unsupported or review. The threshold is applied here, in code.
import { askJev, DEFAULT_MODEL, noul } from "./jev.mjs";
import { mapLimit } from "./load.mjs";

export const DEFAULT_THRESHOLD = 0.8;
export const DEFAULT_TIMEOUT_SECONDS = 10;
/** Estimated tokens of state per request. TypeSafe allows 32k for the state plus the longest question. */
export const STATE_BUDGET = 16_000;
/** Estimated tokens of state plus questions per request. TypeSafe allows 64k for the state plus all questions. */
export const REQUEST_BUDGET = 48_000;
const CONCURRENCY = 4;

/** A rough token count: about four characters per token, which fits English prose. Used for budgets and estimates. */
export const estimateTokens = (text) => Math.ceil(text.length / 4);

export const QUESTION = "Is the value in `claim` supported by `visible_text`, the text a visitor sees on the page?";
export const CRITERIA = {
  true:
    "`visible_text` shows this value for this property of this item. It may be written another way: a different " +
    "date or number format, a currency symbol instead of a currency code, or other words with the same meaning.",
  false:
    "`visible_text` does not show this value, shows a different value for this property, or shows it only for " +
    "another item or property.",
};

/** The one question asked about a claim. The claim travels as data next to the question, not inside its wording. */
export function questionFor(claim) {
  return noul({ claim: { item: claim.item, property: claim.property, value: claim.value }, question: QUESTION }, CRITERIA);
}

const STATE_OVERHEAD = JSON.stringify({ visible_text: "" }).length;
const escapedLength = (text) => JSON.stringify(text).length - 2;

/** Cuts one over-long line between words into pieces that each fit `maxChars` once escaped. */
function cutLine(line, maxChars) {
  const pieces = [];
  let current = "";
  for (const word of line.split(" ")) {
    const next = current ? `${current} ${word}` : word;
    if (escapedLength(next) <= maxChars) {
      current = next;
      continue;
    }
    if (current) pieces.push(current);
    current = word;
    while (escapedLength(current) > maxChars) {
      let end = maxChars;
      while (end > 1 && escapedLength(current.slice(0, end)) > maxChars) end = Math.floor(end * 0.9);
      pieces.push(current.slice(0, end));
      current = current.slice(end);
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Splits a page's visible text at line breaks into parts whose state stays within `budget` estimated tokens. Most
 * pages are one part; each part of a longer page is sent with every claim.
 */
export function splitText(text, budget = STATE_BUDGET) {
  const maxChars = budget * 4 - STATE_OVERHEAD;
  if (escapedLength(text) <= maxChars) return [text];
  const parts = [];
  let current = [];
  let size = 0;
  for (const line of text.split("\n")) {
    for (const piece of escapedLength(line) <= maxChars ? [line] : cutLine(line, maxChars)) {
      const cost = escapedLength(piece) + (current.length ? 2 : 0); // "\n" is two characters once escaped
      if (current.length && size + cost > maxChars) {
        parts.push(current.join("\n"));
        current = [];
        size = 0;
      }
      size += escapedLength(piece) + (current.length ? 2 : 0);
      current.push(piece);
    }
  }
  if (current.length) parts.push(current.join("\n"));
  return parts;
}

/**
 * Plans the requests: for each page with claims and visible text, one request per part of the text, holding every
 * claim (split further only if the questions would pass REQUEST_BUDGET). Returns { pages, requests, parts } where
 * `parts` maps each page to its number of text parts.
 */
export function planRequests(pages, { model = DEFAULT_MODEL } = {}) {
  const requests = [];
  const parts = new Map();
  for (const page of pages) {
    if (page.error || !page.claims.length || !page.text) continue;
    const texts = splitText(page.text);
    parts.set(page, texts.length);
    texts.forEach((text, part) => {
      const state = { visible_text: text };
      // Each piece is rounded up, so the sum is never below the estimate for the whole body.
      const base = estimateTokens(JSON.stringify({ model, state, questions: {} }));
      let group = [];
      let tokens = base;
      const flush = () => {
        if (!group.length) return;
        const questions = Object.fromEntries(group.map((claim) => [claim.id, questionFor(claim)]));
        requests.push({ page, part, claims: group, body: { model, state, questions } });
        group = [];
        tokens = base;
      };
      for (const claim of page.claims) {
        const size = estimateTokens(`${JSON.stringify(claim.id)}:${JSON.stringify(questionFor(claim))},`);
        if (group.length && tokens + size > REQUEST_BUDGET) flush();
        group.push(claim);
        tokens += size;
      }
      flush();
    });
  }
  return { pages, requests, parts };
}

/** Estimated input tokens of a plan, per request and in total, for --dry-run. */
export function estimatePlan(plan) {
  const perRequest = plan.requests.map((request) => estimateTokens(JSON.stringify(request.body)));
  const tokens = perRequest.reduce((sum, n) => sum + n, 0);
  return { perRequest, tokens };
}

// Rounding keeps float noise (1 - 0.8 is 0.19999999999999996) from moving an answer that sits on the threshold.
const round = (value) => Math.round(value * 1e6) / 1e6;

/**
 * A verdict from the probability that the visible text supports the claim: supported at or above `threshold`,
 * unsupported at or below 1 - `threshold`, review in between.
 */
export function decide(probability, threshold = DEFAULT_THRESHOLD) {
  if (round(probability) >= threshold) return "supported";
  if (round(1 - probability) >= threshold) return "unsupported";
  return "review";
}

const isProbability = (value) => typeof value === "number" && value >= 0 && value <= 1;

/**
 * Sends every request in the plan (four at a time) and returns the verdicts by page:
 * { model, threshold, pages: [{ ...page, parts, claims: [{ ...claim, probability, verdict, reason }] }], summary,
 * usage }. A claim's probability is the highest over the parts of its page, so it is supported when any part of the
 * page shows it. Any TypeSafe error (missing key, 401, 422, 429 or 529 after retries, timeout) stops the run with a
 * JevError.
 */
export async function runPlan(plan, options = {}) {
  const {
    threshold = DEFAULT_THRESHOLD,
    apiKey,
    model = DEFAULT_MODEL,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    retries = 3,
    fetchImpl,
    onProgress,
  } = options;
  let done = 0;
  const responses = await mapLimit(plan.requests, CONCURRENCY, async (request) => {
    const response = await askJev(request.body.state, request.body.questions, {
      apiKey,
      model,
      timeoutMs: timeoutSeconds * 1000,
      retries,
      fetchImpl,
    });
    onProgress?.(++done, plan.requests.length);
    return response;
  });

  const answers = new Map();
  plan.requests.forEach((request, i) => {
    for (const claim of request.claims) {
      const entry = answers.get(claim) ?? { values: [], missing: false };
      const value = responses[i].answers?.[claim.id]?.noul;
      if (isProbability(value)) entry.values.push(value);
      else entry.missing = true;
      answers.set(claim, entry);
    }
  });

  const pages = plan.pages.map((page) => ({
    ...page,
    parts: plan.parts.get(page) ?? 0,
    claims: page.claims.map((claim) => {
      if (!page.text) return { ...claim, probability: null, verdict: "review", reason: "no_visible_text" };
      const entry = answers.get(claim);
      const probability = entry?.values.length ? Math.max(...entry.values) : null;
      if (probability !== null && decide(probability, threshold) === "supported") {
        return { ...claim, probability, verdict: "supported", reason: null };
      }
      if (!entry || entry.missing) return { ...claim, probability, verdict: "review", reason: "no_answer" };
      const verdict = decide(probability, threshold);
      return { ...claim, probability, verdict, reason: verdict === "review" ? "unsure" : null };
    }),
  }));
  const summary = { pages: pages.length, pages_not_read: 0, claims: 0, supported: 0, unsupported: 0, review: 0 };
  for (const page of pages) {
    if (page.error) summary.pages_not_read++;
    for (const claim of page.claims) {
      summary.claims++;
      summary[claim.verdict]++;
    }
  }
  const usage = {
    requests: responses.length,
    input_tokens: responses.reduce((sum, r) => sum + (Number(r.usage?.input_tokens) || 0), 0),
    output_tokens: responses.reduce((sum, r) => sum + (Number(r.usage?.output_tokens) || 0), 0),
  };
  return { model: responses[0]?.model ?? model, threshold, pages, summary, usage };
}

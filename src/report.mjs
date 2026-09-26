// Formats results for people (the report, the dry run) and for programs (JSON). Every word printed comes from the
// pages or from the fixed text in this file; Jev returns only probabilities.
import { estimatePlan, estimateTokens, PRICE_PER_MILLION, QUESTION } from "./check.mjs";

export const POLICY_URL = "https://developers.google.com/search/docs/appearance/structured-data/sd-policies";
const ORDER = ["unsupported", "review", "supported"];
const LIST_LIMIT = 20;

const count = (n) => n.toLocaleString("en-US");
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;
const p2 = (value) => (value === null ? "  - " : value.toFixed(2));
const round6 = (value) => Math.round(value * 1e6) / 1e6;

/** A cost in dollars, with enough decimals to show what is usually a fraction of a cent. */
export function money(cost) {
  if (cost === 0) return "$0";
  if (cost < 0.001) return "under $0.001";
  return `about $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

/** Text on one line, cut at a word boundary. */
export function preview(text, max = 90) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 3);
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}...`;
}

const where = ({ block, path }) => `block ${block}${path ? `, ${path}` : ""}`;

/** "1 JSON-LD block (Product)", with the blocks that are not valid JSON called out. */
function describeMarkup(page) {
  if (!page.blocks.length) return "no JSON-LD";
  const invalid = page.blocks.filter((block) => block.error).length;
  const types = page.types.length ? ` (${page.types.join(", ")})` : "";
  return `${plural(page.blocks.length, "JSON-LD block")}${types}${invalid ? `, ${invalid} not valid JSON` : ""}`;
}

function invalidLines(page) {
  return page.blocks
    .filter((block) => block.error)
    .map((block) =>
      block.error === "empty"
        ? `  block ${block.index} (line ${block.line}) is empty`
        : `  block ${block.index} (line ${block.line}) is not valid JSON; its claims were not checked`,
    );
}

function pageLines(page) {
  const lines = ["", page.source];
  if (page.url && page.url !== page.source) lines.push(`  fetched from ${page.url}`);
  if (page.error) return [...lines, `  not read: ${page.error}`];
  const tally = ORDER.map((verdict) => [verdict, page.claims.filter((claim) => claim.verdict === verdict).length])
    .filter(([, n]) => n)
    .map(([verdict, n]) => `${verdict} ${n}`)
    .join(", ");
  const claims = page.claims.length ? `${plural(page.claims.length, "claim")}: ${tally}` : "no claims to check";
  lines.push(`  ${describeMarkup(page)}; ${claims}`, ...invalidLines(page));
  if (page.claims.length && !page.text) {
    lines.push("  no visible text in the HTML; if a script builds the page, save it from a browser and check the file");
  }
  for (const verdict of ORDER) {
    for (const claim of page.claims.filter((entry) => entry.verdict === verdict)) {
      lines.push(`  ${verdict.padEnd(11)}  ${p2(claim.probability)}  ${claim.property}: ${preview(claim.value)}`);
      if (verdict !== "supported") lines.push(`${" ".repeat(21)}${claim.item}; ${where(claim.paths[0])}`);
    }
  }
  return lines;
}

/** The human-readable report: counts, then every page with its claims, the doubtful ones first. */
export function formatReport(result) {
  const { summary, usage, threshold } = result;
  const cost = (usage.input_tokens * PRICE_PER_MILLION) / 1e6;
  const lines = [
    `schema-truth: ${plural(summary.claims, "claim")} on ${plural(summary.pages, "page")}`,
    usage.requests
      ? `Model ${result.model}, ${plural(usage.requests, "request")}, ${count(usage.input_tokens)} input tokens ` +
        `(${money(cost)}), threshold ${threshold}`
      : `Nothing to ask TypeSafe, threshold ${threshold}`,
    "",
    `supported ${summary.supported}   unsupported ${summary.unsupported}   review ${summary.review}` +
      (summary.pages_not_read ? `   pages not read ${summary.pages_not_read}` : ""),
  ];
  for (const page of result.pages) lines.push(...pageLines(page));
  const low = round6(1 - threshold);
  const notes = [];
  if (summary.supported) notes.push(`supported: the visible text shows the value (probability at or above ${threshold}).`);
  if (summary.unsupported) {
    notes.push(
      `unsupported: the visible text does not show it (probability at or below ${low}). Google asks that structured`,
      "  data describe only content visible to readers of the page:",
      `  ${POLICY_URL}`,
    );
  }
  if (summary.review) notes.push("review: Jev was not sure either way, or had no text to read. Check these on the page yourself.");
  if (notes.length) lines.push("", ...notes);
  return `${lines.join("\n")}\n`;
}

const claimJson = (claim) => ({
  id: claim.id,
  item: claim.item,
  property: claim.property,
  value: claim.value,
  ...(claim.raw !== undefined ? { raw: claim.raw } : {}),
  paths: claim.paths,
});

function pageJson(page) {
  return {
    source: page.source,
    url: page.url,
    error: page.error,
    jsonld_blocks: page.blocks.length,
    invalid_blocks: page.blocks.filter((block) => block.error).map(({ index, line, error }) => ({ block: index, line, error })),
    types: page.types,
    visible_text_tokens: estimateTokens(page.text),
  };
}

/** The report as JSON: every page and claim, its verdict and the raw probability. */
export function toJson(result, meta) {
  const cost = (result.usage.input_tokens * PRICE_PER_MILLION) / 1e6;
  return {
    tool: "schema-truth",
    version: meta.version,
    threshold: result.threshold,
    model: result.model,
    summary: result.summary,
    usage: { ...result.usage, estimated_cost_usd: round6(cost) },
    pages: result.pages.map((page) => ({
      ...pageJson(page),
      parts: page.parts,
      claims: page.claims.map((claim) => ({
        ...claimJson(claim),
        probability: claim.probability,
        verdict: claim.verdict,
        reason: claim.reason,
      })),
    })),
  };
}

/** What --dry-run prints: each page's markup and claims, the requests and the token estimate. */
export function formatDryRun(plan, meta) {
  const estimate = estimatePlan(plan);
  const claims = plan.pages.reduce((sum, page) => sum + page.claims.length, 0);
  const lines = ["Dry run: nothing was sent to TypeSafe.", "", `${plural(claims, "claim")} on ${plural(plan.pages.length, "page")}`];
  const shown = plan.pages.slice(0, LIST_LIMIT);
  const width = Math.max(...shown.map((page) => page.source.length));
  for (const page of shown) {
    const detail = page.error
      ? `not read: ${page.error}`
      : `${describeMarkup(page)}, ${plural(page.claims.length, "claim")}, visible text about ${plural(estimateTokens(page.text), "token")}`;
    lines.push(`  ${page.source.padEnd(width)}  ${detail}`);
  }
  if (plan.pages.length > shown.length) lines.push(`  and ${plural(plan.pages.length - shown.length, "more page")}`);
  lines.push(
    "",
    `${plural(plan.requests.length, "request")} to ${meta.model}, about ${count(estimate.tokens)} input tokens ` +
      `(${money(estimate.cost)} at $${PRICE_PER_MILLION} per million input tokens)`,
  );
  const listed = shown.filter((page) => page.claims.length);
  if (listed.length) {
    lines.push("", "Each claim is one yes/no question (noul), asked against the page's visible text:", `  ${QUESTION}`);
    for (const page of listed) {
      lines.push("", `${page.source}`);
      for (const claim of page.claims) lines.push(`  ${claim.id.padEnd(4)} ${claim.property}: ${preview(claim.value, 70)}  [${claim.item}]`);
    }
  }
  lines.push("", "Run with --dry-run --json to see every request body, including the visible text.");
  return `${lines.join("\n")}\n`;
}

/** What --dry-run --json prints: the pages, their claims and every request body exactly as it would be sent. */
export function dryRunJson(plan, meta) {
  const estimate = estimatePlan(plan);
  return {
    tool: "schema-truth",
    version: meta.version,
    dry_run: true,
    model: meta.model,
    summary: {
      pages: plan.pages.length,
      pages_not_read: plan.pages.filter((page) => page.error).length,
      claims: plan.pages.reduce((sum, page) => sum + page.claims.length, 0),
      requests: plan.requests.length,
    },
    estimated_input_tokens: estimate.tokens,
    estimated_cost_usd: round6(estimate.cost),
    pages: plan.pages.map((page) => ({ ...pageJson(page), claims: page.claims.map(claimJson) })),
    requests: plan.requests.map((request, i) => ({
      source: request.page.source,
      part: request.part + 1,
      claims: request.claims.map((claim) => claim.id),
      estimated_tokens: estimate.perRequest[i],
      body: request.body,
    })),
  };
}

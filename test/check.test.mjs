import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import test from "node:test";
import { decide, estimateTokens, planRequests, REQUEST_BUDGET, runPlan, splitText, STATE_BUDGET } from "../src/check.mjs";
import { fixtureFetch } from "../src/jev.mjs";
import { readPage } from "../src/load.mjs";

// Any attempt to reach the network fails loudly: TypeSafe through fetch, a page through DNS, http or https.
const offline = () => {
  throw new Error("Tests must not use the network.");
};
globalThis.fetch = offline;
dns.lookup = dns.promises.lookup = offline;
http.request = http.get = https.request = https.get = offline;

const QUESTION = "Is the value in `claim` supported by `visible_text`, the text a visitor sees on the page?";
const CRITERIA = {
  true:
    "`visible_text` shows this value for this property of this item. It may be written another way: a different " +
    "date or number format, a currency symbol instead of a currency code, or other words with the same meaning.",
  false:
    "`visible_text` does not show this value, shows a different value for this property, or shows it only for " +
    "another item or property.",
};

/** A page as readPage returns it, with claims made up for the test. */
const page = (source, text, count) => ({
  source,
  error: null,
  blocks: [],
  types: [],
  text,
  claims: Array.from({ length: count }, (_, i) => ({
    id: `c${i + 1}`,
    item: "Mug (Product)",
    property: "price",
    value: `${i + 1}.00 EUR`,
    paths: [{ block: 1, path: "offers.price" }],
  })),
});

test("the request body: the page's visible text as state, one noul per claim with the claim as data", () => {
  const html =
    '<script type="application/ld+json">{"@type": "Product", "name": "Mug", "offers": {"@type": "Offer", "price": "12.50", ' +
    '"priceCurrency": "EUR", "availability": "https://schema.org/OutOfStock"}}</script><h1>Mug</h1><p>&euro;12,50, in stock</p>';
  const plan = planRequests([readPage("mug.html", html)], { model: "jev-latest" });
  assert.equal(plan.requests.length, 1);
  assert.deepEqual(plan.requests[0].body, {
    model: "jev-latest",
    state: { visible_text: "Mug\n€12,50, in stock" },
    questions: {
      c1: {
        type: "noul",
        instructions: { claim: { item: "Mug (Product)", property: "price", value: "12.50 EUR" }, question: QUESTION },
        criteria: CRITERIA,
      },
      c2: {
        type: "noul",
        instructions: { claim: { item: "Mug (Product)", property: "availability", value: "out of stock" }, question: QUESTION },
        criteria: CRITERIA,
      },
    },
  });
});

test("long pages are split into parts under the state budget; many claims are split under the request budget", () => {
  const lines = Array.from({ length: 2_000 }, (_, i) => `Line ${i}: ${"word ".repeat(8)}end.`);
  const text = lines.join("\n");
  const parts = splitText(text);
  assert.equal(parts.length, 2);
  assert.equal(parts.join("\n"), text, "no text is lost or reordered");
  for (const part of parts) assert.ok(estimateTokens(JSON.stringify({ visible_text: part })) <= STATE_BUDGET);

  const oneLine = "word ".repeat(30_000).trim(); // about 37,500 tokens without a line break
  const pieces = splitText(oneLine);
  assert.equal(pieces.length, 3);
  assert.equal(pieces.join(" "), oneLine, "a long line is cut between words");
  assert.deepEqual(splitText("Short page"), ["Short page"]);

  const plan = planRequests([page("long.html", text, 3), page("many.html", "Short page", 400), page("empty.html", "", 2)]);
  const bySource = (source) => plan.requests.filter((request) => request.page.source === source);
  assert.deepEqual(
    bySource("long.html").map((request) => [request.part, Object.keys(request.body.questions)]),
    [
      [0, ["c1", "c2", "c3"]],
      [1, ["c1", "c2", "c3"]],
    ],
  );
  const many = bySource("many.html");
  assert.ok(many.length > 1, "400 questions do not fit in one request");
  assert.deepEqual(
    many.flatMap((request) => request.claims.map((claim) => claim.id)),
    Array.from({ length: 400 }, (_, i) => `c${i + 1}`),
  );
  for (const request of plan.requests) assert.ok(estimateTokens(JSON.stringify(request.body)) <= REQUEST_BUDGET);
  assert.equal(bySource("empty.html").length, 0, "a page without visible text is not sent");
  assert.equal(plan.parts.get(plan.pages[0]), 2);
});

test("decide: supported, unsupported and review at, above and below the threshold", () => {
  assert.equal(decide(0.8, 0.8), "supported");
  assert.equal(decide(0.97, 0.8), "supported");
  assert.equal(decide(0.79, 0.8), "review");
  assert.equal(decide(0.5, 0.8), "review");
  assert.equal(decide(0.21, 0.8), "review");
  assert.equal(decide(0.2, 0.8), "unsupported");
  assert.equal(decide(0, 0.8), "unsupported");
  assert.equal(decide(0.85, 0.9), "review");
  assert.equal(decide(0.9, 0.9), "supported");
  assert.equal(decide(0.1, 0.9), "unsupported");
  assert.equal(decide(0.11, 0.9), "review");
  assert.equal(decide(0.6, 0.55), "supported");
});

test("runPlan: the highest probability over a page's parts, verdicts with reasons, usage summed", async () => {
  const lines = Array.from({ length: 2_000 }, (_, i) => `Line ${i}: ${"word ".repeat(8)}end.`);
  const long = page("long.html", lines.join("\n"), 2);
  const short = page("short.html", "Mug\n€12,50", 3);
  const blank = page("blank.html", "", 1);
  const broken = { ...page("https://shop.example/gone", "", 0), error: "the server answered HTTP 404" };
  const plan = planRequests([long, short, blank, broken]);
  assert.equal(plan.requests.length, 3);

  const { fetchImpl, calls } = fixtureFetch((body) => {
    const first = body.state.visible_text.startsWith("Line 0:");
    const answers =
      body.state.visible_text === "Mug\n€12,50"
        ? { c1: { type: "noul", noul: 0.5 }, c3: { type: "noul", noul: 0.02 } }
        : { c1: { type: "noul", noul: first ? 0.1 : 0.9 }, c2: { type: "noul", noul: first ? 0.05 : 0.1 } };
    return { model: "jev-1.13.0", answers, usage: { input_tokens: 1000, output_tokens: 10 } };
  });
  const result = await runPlan(plan, { apiKey: "test-key", fetchImpl });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(call.headers.authorization, "Bearer test-key");
  }
  const verdicts = (source) =>
    result.pages.find((entry) => entry.source === source).claims.map((claim) => [claim.id, claim.probability, claim.verdict, claim.reason]);
  assert.deepEqual(verdicts("long.html"), [
    ["c1", 0.9, "supported", null],
    ["c2", 0.1, "unsupported", null],
  ]);
  assert.deepEqual(verdicts("short.html"), [
    ["c1", 0.5, "review", "unsure"],
    ["c2", null, "review", "no_answer"],
    ["c3", 0.02, "unsupported", null],
  ]);
  assert.deepEqual(verdicts("blank.html"), [["c1", null, "review", "no_visible_text"]]);
  assert.equal(result.pages.find((entry) => entry.source === "long.html").parts, 2);
  assert.deepEqual(result.summary, { pages: 4, pages_not_read: 1, claims: 6, supported: 1, unsupported: 2, review: 3 });
  assert.deepEqual(result.usage, { requests: 3, input_tokens: 3000, output_tokens: 30 });
  assert.equal(result.model, "jev-1.13.0");
});

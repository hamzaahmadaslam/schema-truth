import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import test from "node:test";
import { planRequests, runPlan } from "../src/check.mjs";
import { fixtureFetch, JevError } from "../src/jev.mjs";
import { readPage } from "../src/load.mjs";

// Any attempt to reach the network fails loudly: TypeSafe through fetch, a page through DNS, http or https.
const offline = () => {
  throw new Error("Tests must not use the network.");
};
globalThis.fetch = offline;
dns.lookup = dns.promises.lookup = offline;
http.request = http.get = https.request = https.get = offline;

// One page with one claim, so every run is exactly one request.
const plan = planRequests([
  readPage(
    "mug.html",
    '<script type="application/ld+json">{"@type": "Product", "name": "Mug", "offers": {"price": "12", "priceCurrency": "EUR"}}</script><p>Mug, 12 euros</p>',
  ),
]);

const okAnswers = () => ({
  model: "jev-1.13.0",
  answers: { c1: { type: "noul", noul: 0.93 } },
  usage: { input_tokens: 300, output_tokens: 5 },
});

const jevError = (status, message) => (error) =>
  error instanceof JevError && error.status === status && (message instanceof RegExp ? message.test(error.message) : error.message === message);

test("a missing key is a plain error, and no request is made", async () => {
  assert.equal(plan.requests.length, 1);
  const { fetchImpl, calls } = fixtureFetch(okAnswers);
  for (const apiKey of ["", "   "]) {
    await assert.rejects(runPlan(plan, { apiKey, fetchImpl }), jevError(0, /^TYPESAFE_API_KEY is not set\./));
  }
  assert.equal(calls.length, 0);
});

test("401 and 422 stop the run at once with a plain message", async () => {
  const refused = fixtureFetch(() => 401);
  await assert.rejects(
    runPlan(plan, { apiKey: "test-key", fetchImpl: refused.fetchImpl }),
    jevError(401, "TypeSafe error: the API key was refused"),
  );
  assert.equal(refused.calls.length, 1);

  const invalid = fixtureFetch(() => 422);
  await assert.rejects(
    runPlan(plan, { apiKey: "test-key", fetchImpl: invalid.fetchImpl }),
    jevError(422, 'TypeSafe error: the request was invalid: {"error":"fixture"}'),
  );
  assert.equal(invalid.calls.length, 1);
});

test("429 and 529 are retried with backoff, then succeed or stop with a plain message", async () => {
  const limited = fixtureFetch((body, call) => (call === 1 ? 429 : okAnswers()));
  const result = await runPlan(plan, { apiKey: "test-key", fetchImpl: limited.fetchImpl, retries: 1 });
  assert.equal(limited.calls.length, 2);
  assert.equal(result.summary.supported, 1);

  const busy = fixtureFetch(() => 529);
  await assert.rejects(
    runPlan(plan, { apiKey: "test-key", fetchImpl: busy.fetchImpl, retries: 1 }),
    jevError(529, "TypeSafe error: TypeSafe is overloaded; try again later"),
  );
  assert.equal(busy.calls.length, 2);
});

test("a TypeSafe request that takes too long stops with a plain timeout message", async () => {
  let calls = 0;
  // A slow server: it would answer after five seconds, which also keeps the event loop alive the way a socket does.
  const hanging = (url, init) => {
    calls++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify(okAnswers()))), 5_000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal.reason);
      });
    });
  };
  await assert.rejects(
    runPlan(plan, { apiKey: "test-key", fetchImpl: hanging, timeoutSeconds: 0.05, retries: 0 }),
    jevError(0, "Could not reach TypeSafe: timed out"),
  );
  assert.equal(calls, 1);
});

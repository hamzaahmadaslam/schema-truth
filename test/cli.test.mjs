import assert from "node:assert/strict";
import dns from "node:dns";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { exampleFetch, PAGES } from "../examples/run.mjs";
import { main, USAGE } from "../src/cli.mjs";
import { fixtureFetch } from "../src/jev.mjs";
import { listInputs } from "../src/load.mjs";

// Any attempt to reach the network fails loudly: TypeSafe through fetch, a page through DNS, http or https.
const offline = () => {
  throw new Error("Tests must not use the network.");
};
globalThis.fetch = offline;
dns.lookup = dns.promises.lookup = offline;
http.request = http.get = https.request = https.get = offline;

const KEY = "test-key-never-printed";
const example = (name) => readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Runs the CLI in this process with captured output. The default fetch fails, so nothing can reach the network. */
async function run(args, { env = {}, fetchImpl = globalThis.fetch, resolve, transport } = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    env,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    fetchImpl,
    resolve,
    transport,
  });
  return { code, stdout, stderr };
}

/** Answers every question with the same probability. */
const answerAll = (noul) =>
  fixtureFetch((body) => ({
    model: "jev-1.13.0",
    answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul }])),
    usage: { input_tokens: 500, output_tokens: 0 },
  }));

test("tests cannot reach the network: fetch, DNS and http are replaced", async () => {
  await assert.rejects(async () => globalThis.fetch("https://api.typesafe.ai/v1/systemone"), /must not use the network/);
  await assert.rejects(async () => dns.promises.lookup("example.com"), /must not use the network/);
  assert.throws(() => http.request("http://example.com/"), /must not use the network/);
});

test("the example in examples/ reproduces report.txt, report.json and dry-run.txt exactly", async () => {
  const report = await run([PAGES], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl: (await exampleFetch()).fetchImpl });
  assert.equal(report.code, 1, "six unsupported claims, so the exit code is 1");
  assert.equal(report.stdout, example("report.txt"));
  assert.equal(report.stderr, "");

  const json = await run([PAGES, "--json"], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl: (await exampleFetch()).fetchImpl });
  assert.equal(json.stdout, example("report.json"));
  assert.deepEqual(JSON.parse(json.stdout).summary, {
    pages: 3,
    pages_not_read: 0,
    claims: 20,
    supported: 12,
    unsupported: 6,
    review: 2,
  });

  const dry = await run([PAGES, "--dry-run"]);
  assert.equal(dry.stdout, example("dry-run.txt"));

  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(readme.includes(example("report.txt")), "the README shows examples/report.txt exactly");
  for (const output of [report, json, dry]) assert.ok(!(output.stdout + output.stderr).includes(KEY), "the key is never printed");
});

test("--dry-run prints the claims, the question and a token estimate without a key and without a request", async () => {
  const { fetchImpl, calls } = fixtureFetch(() => 500);
  const text = await run([PAGES, "--dry-run"], { fetchImpl });
  assert.equal(text.code, 0);
  assert.match(text.stdout, /^Dry run: nothing was sent to TypeSafe\./);
  assert.match(text.stdout, /3 requests to jev-latest, about [\d,]+ input tokens/);
  assert.match(text.stdout, /c4 {3}date modified: 19 August 2026 {2}\[How to dry wet trail shoes \(BlogPosting\)\]/);

  const json = await run([PAGES, "--dry-run", "--json"], { env: { TYPESAFE_MODEL: "jev-1.13.0" }, fetchImpl });
  const data = JSON.parse(json.stdout);
  assert.equal(data.dry_run, true);
  assert.equal(data.model, "jev-1.13.0");
  assert.deepEqual(
    data.requests.map((request) => [request.source, request.part, request.claims.length]),
    [
      ["delivery-faq.html", 1, 6],
      ["shoe-care-guide.html", 1, 6],
      ["trail-runner.html", 1, 8],
    ],
  );
  assert.equal(data.requests[2].body.model, "jev-1.13.0");
  assert.match(data.requests[2].body.state.visible_text, /^Northfield Outfitters Shoes Delivery\nTrail Runner 2\n/);
  assert.ok(!data.requests[2].body.state.visible_text.includes("Sam P."), "a review in a hidden element is not visible text");
  assert.deepEqual(data.pages[1].invalid_blocks, [{ block: 2, line: 41, error: "invalid" }]);
  assert.equal(data.estimated_input_tokens, data.requests.reduce((sum, request) => sum + request.estimated_tokens, 0));
  assert.equal(calls.length, 0);
});

/** A stand-in page server: URL to [status, headers, body]. */
function pageServer(routes) {
  const transport = async (url) => {
    const [statusCode, headers, body = ""] = routes[url.href] ?? [404, {}];
    return Object.assign(Readable.from([Buffer.from(body)], { objectMode: false }), { statusCode, headers });
  };
  const addresses = { "shop.example": ["93.184.215.14"], "intranet.example": ["10.0.0.2"] };
  const resolve = async (host) => (addresses[host] ?? []).map((address) => ({ address, family: 4 }));
  return { transport, resolve };
}

const PRODUCT = (name, price) =>
  `<html><head><script type="application/ld+json">{"@type": "Product", "name": "${name}", "offers": {"@type": "Offer", ` +
  `"price": "${price}", "priceCurrency": "USD"}}</script></head><body><h1>${name}</h1><p>$${price}</p></body></html>`;

test("URLs: pages are fetched, redirects followed, a refused page is reported and the others still checked", async () => {
  const server = pageServer({
    "https://shop.example/mug": [200, { "content-type": "text/html" }, PRODUCT("Mug", "12.00")],
    "http://shop.example/old-cup": [301, { location: "https://shop.example/cup" }],
    "https://shop.example/cup": [200, { "content-type": "text/html; charset=utf-8" }, PRODUCT("Cup", "9.00")],
  });
  const answers = answerAll(0.95);
  const args = ["https://shop.example/mug", "http://shop.example/old-cup", "http://intranet.example/", "https://shop.example/gone"];
  const { code, stdout, stderr } = await run(args, { env: { TYPESAFE_API_KEY: KEY }, fetchImpl: answers.fetchImpl, ...server });
  assert.equal(code, 2, "two pages could not be read");
  assert.equal(stderr, "");
  assert.equal(answers.calls.length, 2);
  assert.match(stdout, /^schema-truth: 2 claims on 4 pages\n/);
  assert.match(stdout, /supported 2 {3}unsupported 0 {3}review 0 {3}pages not read 2/);
  assert.match(stdout, /\nhttp:\/\/shop\.example\/old-cup\n {2}fetched from https:\/\/shop\.example\/cup\n {2}1 JSON-LD block \(Product\); 1 claim: supported 1\n {2}supported {4}0\.95 {2}price: 9\.00 USD\n/);
  assert.match(stdout, /\nhttp:\/\/intranet\.example\/\n {2}not read: refused: intranet\.example resolves to 10\.0\.0\.2, which is a private network address\n/);
  assert.match(stdout, /\nhttps:\/\/shop\.example\/gone\n {2}not read: the server answered HTTP 404\n/);

  const json = await run([...args, "--json"], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl: answerAll(0.1).fetchImpl, ...server });
  const data = JSON.parse(json.stdout);
  assert.equal(json.code, 2);
  assert.deepEqual(
    data.pages.map((page) => [page.source, page.url, page.error, page.claims.map((claim) => claim.verdict)]),
    [
      ["https://shop.example/mug", "https://shop.example/mug", null, ["unsupported"]],
      ["http://shop.example/old-cup", "https://shop.example/cup", null, ["unsupported"]],
      ["http://intranet.example/", null, "refused: intranet.example resolves to 10.0.0.2, which is a private network address", []],
      ["https://shop.example/gone", null, "the server answered HTTP 404", []],
    ],
  );

  const onlyGood = await run(["https://shop.example/mug"], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl: answerAll(0.1).fetchImpl, ...server });
  assert.equal(onlyGood.code, 1, "an unsupported claim and every page read");
});

test("inputs: folders and files together, pages without JSON-LD need no key, and bad input is a plain error", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "schema-truth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "plain.html"), "<h1>No markup here</h1>");
  writeFileSync(path.join(root, "notes.txt"), "not html");
  const file = path.join(root, "plain.html");

  assert.deepEqual(
    listInputs([PAGES, file]).map((input) => input.source),
    [
      `${PAGES.split(path.sep).join("/")}/delivery-faq.html`,
      `${PAGES.split(path.sep).join("/")}/shoe-care-guide.html`,
      `${PAGES.split(path.sep).join("/")}/trail-runner.html`,
      file.split(path.sep).join("/"),
    ],
  );

  const plain = await run([file]);
  assert.equal(plain.code, 0);
  assert.equal(
    plain.stdout,
    "schema-truth: 0 claims on 1 page\nNothing to ask TypeSafe, threshold 0.8\n\nsupported 0   unsupported 0   review 0\n\nplain.html\n  no JSON-LD; no claims to check\n",
  );

  const cases = [
    [[PAGES, "--threshold", "0.4"], '--threshold must be a number above 0.5 and at most 1, not "0.4".'],
    [[PAGES, "--threshold", "high"], /^--threshold must be a number above 0\.5/],
    [[PAGES, "--timeout", "0"], '--timeout must be a number of seconds above 0 and at most 600, not "0".'],
    [[PAGES, "--frobnicate"], /Unknown option '--frobnicate'.*Run schema-truth --help/],
    [[], /^Give at least one URL, saved HTML file or folder to check\./],
    [["no-such-page.html"], "Cannot read no-such-page.html: there is no such file or folder."],
    [["shop.example/mug"], "Cannot read shop.example/mug: there is no such file or folder. For a web page, start the URL with https://."],
    [[path.join(root, "notes.txt")], /notes\.txt is not a URL, an HTML file \(\.html, \.htm, \.xhtml\) or a folder\.$/],
    [["ftp://files.example/page.html"], "ftp://files.example/page.html: only http and https URLs are fetched, not ftp."],
    [[PAGES], /^TYPESAFE_API_KEY is not set\./],
  ];
  for (const [args, expected] of cases) {
    const { code, stdout, stderr } = await run(args, { env: { TYPESAFE_API_KEY: "  " } });
    const label = args.join(" ") || "(no arguments)";
    assert.equal(code, 2, label);
    assert.equal(stdout, "", label);
    assert.equal(stderr.split("\n").length, 2, `one line for ${label}`);
    assert.ok(stderr.startsWith("schema-truth: "), label);
    const message = stderr.slice("schema-truth: ".length).trimEnd();
    if (typeof expected === "string") assert.equal(message, expected, label);
    else assert.match(message, expected, label);
  }
});

test("--help and --version", async () => {
  assert.deepEqual(await run(["--help"]), { code: 0, stdout: USAGE, stderr: "" });
  assert.deepEqual(await run(["-v"]), { code: 0, stdout: "1.0.0\n", stderr: "" });
});

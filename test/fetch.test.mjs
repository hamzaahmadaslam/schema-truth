import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import test from "node:test";
import zlib from "node:zlib";
import { blockedReason, fetchPage, MAX_BYTES, MAX_REDIRECTS, parseHttpUrl } from "../src/fetch.mjs";
import { USER_AGENT } from "../src/version.mjs";

// Any attempt to reach the network fails loudly: TypeSafe through fetch, a page through DNS, http or https.
const offline = () => {
  throw new Error("Tests must not use the network.");
};
globalThis.fetch = offline;
dns.lookup = dns.promises.lookup = offline;
http.request = http.get = https.request = https.get = offline;

// Public addresses used as stand-ins; nothing connects to them.
const PUBLIC_V4 = "93.184.215.14";
const PUBLIC_V6 = "2606:2800:21f:cb07:6820:80da:af6b:8b2c";

/** A stand-in DNS: host name to addresses, as dns.promises.lookup(host, { all: true }) returns them. */
function fakeDns(table) {
  const asked = [];
  const resolve = async (host) => {
    asked.push(host);
    if (!table[host]) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return table[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { resolve, asked };
}

/** A response stream shaped like Node's IncomingMessage. */
function response(statusCode, headers = {}, body = "") {
  const chunks = Array.isArray(body) ? body : [Buffer.from(body)];
  return Object.assign(Readable.from(chunks, { objectMode: false }), { statusCode, headers });
}

/** A stand-in transport that answers each URL from a table and records every call. */
function fakeTransport(routes) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url: url.href, headers: init.headers, lookup: init.lookup });
    const route = routes[url.href];
    if (!route) throw new Error(`unexpected request to ${url.href}`);
    return typeof route === "function" ? route(init) : route();
  };
  return { transport, calls };
}

const html = (text) => () => response(200, { "content-type": "text/html; charset=utf-8" }, text);
const refusal = (message) => (error) => error.name === "FetchError" && error.message === message;

test("blockedReason: loopback, private, link-local, metadata and other special ranges, IPv4 and IPv6", () => {
  const cases = {
    "127.0.0.1": "loopback",
    "127.8.9.10": "loopback",
    "10.1.2.3": "private",
    "172.16.0.1": "private",
    "172.31.255.255": "private",
    "172.32.0.1": null,
    "192.168.1.1": "private",
    "100.64.0.1": "private",
    "169.254.1.1": "link-local",
    "169.254.169.254": "metadata",
    "169.254.170.2": "metadata",
    "100.100.100.200": "metadata",
    "192.0.0.192": "metadata",
    "0.0.0.0": "unspecified",
    "224.0.0.1": "multicast",
    "255.255.255.255": "reserved",
    "198.51.100.7": "reserved",
    [PUBLIC_V4]: null,
    "8.8.8.8": null,
    "::": "unspecified",
    "::1": "loopback",
    "[::1]": "loopback",
    "::ffff:127.0.0.1": "loopback",
    "::ffff:7f00:1": "loopback",
    "::ffff:10.0.0.1": "private",
    "::ffff:a9fe:a9fe": "metadata",
    [`::ffff:${PUBLIC_V4}`]: null,
    "::10.0.0.1": "reserved",
    "64:ff9b::a00:1": "private",
    "64:ff9b::808:808": null,
    "64:ff9b:1::1": "private",
    "fc00::1": "private",
    "fd12:3456::1": "private",
    "fd00:ec2::254": "metadata",
    "fe80::1": "link-local",
    "fe80::1%eth0": "link-local",
    "fec0::1": "private",
    "ff02::1": "multicast",
    "2001:db8::1": "reserved",
    "2001::1": "reserved",
    "2002:c0a8:101::1": "reserved",
    "4000::1": "reserved",
    [PUBLIC_V6]: null,
    "not-an-address": "invalid",
  };
  for (const [address, reason] of Object.entries(cases)) assert.equal(blockedReason(address), reason, address);
});

test("only http and https; addresses in the URL are checked as written, before any lookup or connection", async () => {
  const dns = fakeDns({});
  const { transport, calls } = fakeTransport({});
  const options = { resolve: dns.resolve, transport };
  assert.throws(() => parseHttpUrl("ftp://files.example/page.html"), refusal("only http and https URLs are fetched, not ftp"));
  await assert.rejects(fetchPage("file:///etc/hosts", options), refusal("only http and https URLs are fetched, not file"));
  await assert.rejects(fetchPage("not a url", options), refusal("not a valid URL"));
  const literal = {
    "http://127.0.0.1/": "refused: 127.0.0.1 is a loopback address",
    "http://2130706433/": "refused: 127.0.0.1 is a loopback address",
    "http://0x7f.1:8080/": "refused: 127.0.0.1 is a loopback address",
    "http://[::1]/": "refused: ::1 is a loopback address",
    "http://[::ffff:169.254.169.254]/latest": "refused: ::ffff:a9fe:a9fe is a cloud metadata address",
    "https://169.254.169.254/": "refused: 169.254.169.254 is a cloud metadata address",
    "http://10.0.0.8/": "refused: 10.0.0.8 is a private network address",
  };
  for (const [url, message] of Object.entries(literal)) await assert.rejects(fetchPage(url, options), refusal(message), url);
  assert.deepEqual(dns.asked, []);
  assert.equal(calls.length, 0);
});

test("a host name is refused when any of its addresses is private, and nothing connects", async () => {
  const dns = fakeDns({
    "mixed.example": [PUBLIC_V4, "10.0.0.5"],
    "localhost": ["::1", "127.0.0.1"],
    "rebind.example": [PUBLIC_V6, "fd00:ec2::254"],
  });
  const { transport, calls } = fakeTransport({});
  const options = { resolve: dns.resolve, transport };
  await assert.rejects(
    fetchPage("http://mixed.example/", options),
    refusal("refused: mixed.example resolves to 10.0.0.5, which is a private network address"),
  );
  await assert.rejects(fetchPage("http://localhost:3000/", options), refusal("refused: localhost resolves to ::1, which is a loopback address"));
  await assert.rejects(
    fetchPage("https://rebind.example/", options),
    refusal("refused: rebind.example resolves to fd00:ec2::254, which is a cloud metadata address"),
  );
  await assert.rejects(
    fetchPage("https://missing.example/", options),
    refusal("could not resolve the host name missing.example (ENOTFOUND)"),
  );
  assert.equal(calls.length, 0);
});

test("redirects: at most 3, every hop checked again, and the connection only gets the checked addresses", async () => {
  const dns = fakeDns({
    "shop.example": [PUBLIC_V4],
    "cdn.example": [PUBLIC_V6, PUBLIC_V4],
    "intranet.example": ["192.168.0.10"],
  });
  const good = fakeTransport({
    "http://shop.example/a": () => response(301, { location: "/b?x=1" }),
    "http://shop.example/b?x=1": () => response(302, { location: "https://cdn.example/c" }),
    "https://cdn.example/c": html("<p>Final page</p>"),
  });
  const page = await fetchPage("http://shop.example/a#top", { resolve: dns.resolve, transport: good.transport, userAgent: USER_AGENT });
  assert.equal(page.url, "https://cdn.example/c");
  assert.equal(page.body.toString(), "<p>Final page</p>");
  assert.deepEqual(dns.asked, ["shop.example", "shop.example", "cdn.example"]);
  assert.deepEqual(
    good.calls.map((call) => call.url),
    ["http://shop.example/a", "http://shop.example/b?x=1", "https://cdn.example/c"],
  );
  for (const call of good.calls) assert.equal(call.headers["user-agent"], USER_AGENT);
  assert.match(USER_AGENT, /^schema-truth\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/hamzaahmadaslam\/schema-truth\)$/);

  // The lookup handed to the connection answers only with the checked addresses, whatever it is asked.
  const lookup = good.calls[2].lookup;
  const ask = (options) => new Promise((resolve, reject) => lookup("cdn.example", options, (error, ...rest) => (error ? reject(error) : resolve(rest))));
  assert.deepEqual(await ask({ all: true }), [[{ address: PUBLIC_V6, family: 6 }, { address: PUBLIC_V4, family: 4 }]]);
  assert.deepEqual(await ask({ family: 4 }), [PUBLIC_V4, 4]);
  assert.deepEqual(await ask({}), [PUBLIC_V6, 6]);

  const toPrivate = fakeTransport({ "http://shop.example/go": () => response(302, { location: "http://intranet.example/admin" }) });
  await assert.rejects(
    fetchPage("http://shop.example/go", { resolve: dns.resolve, transport: toPrivate.transport }),
    refusal("refused: intranet.example resolves to 192.168.0.10, which is a private network address"),
  );
  assert.equal(toPrivate.calls.length, 1);

  const toFile = fakeTransport({ "http://shop.example/go": () => response(302, { location: "file:///etc/passwd" }) });
  await assert.rejects(
    fetchPage("http://shop.example/go", { resolve: dns.resolve, transport: toFile.transport }),
    refusal("only http and https URLs are fetched, not file"),
  );
  const toNowhere = fakeTransport({ "http://shop.example/go": () => response(302, { location: "http://[not-an-address/" }) });
  await assert.rejects(
    fetchPage("http://shop.example/go", { resolve: dns.resolve, transport: toNowhere.transport }),
    refusal("the server redirected to an address that is not a valid URL"),
  );

  const loop = fakeTransport(
    Object.fromEntries([0, 1, 2, 3, 4].map((n) => [`http://shop.example/${n}`, () => response(307, { location: `/${n + 1}` })])),
  );
  await assert.rejects(
    fetchPage("http://shop.example/0", { resolve: dns.resolve, transport: loop.transport }),
    refusal(`stopped after ${MAX_REDIRECTS} redirects`),
  );
  assert.equal(loop.calls.length, MAX_REDIRECTS + 1);
});

test("limits and answers: 2 MB cap, time limit, HTTP errors, non-HTML pages, compressed bodies", async () => {
  assert.equal(MAX_BYTES, 2 * 1024 * 1024);
  const dns = fakeDns({ "shop.example": [PUBLIC_V4] });
  const get = (routes, extra = {}) => fetchPage("http://shop.example/p", { resolve: dns.resolve, transport: fakeTransport(routes).transport, ...extra });
  const route = (make) => ({ "http://shop.example/p": make });

  const big = Array.from({ length: 5 }, () => Buffer.alloc(300, "a"));
  await assert.rejects(get(route(() => response(200, { "content-type": "text/html" }, big)), { maxBytes: 1000 }), refusal("the page is larger than 1000 bytes"));
  await assert.rejects(
    get(route(() => response(200, { "content-type": "text/html", "content-length": String(MAX_BYTES + 1) }))),
    refusal("the page is larger than 2 MB"),
  );
  await assert.rejects(get(route(() => response(404, { "content-type": "text/html" }))), refusal("the server answered HTTP 404"));
  await assert.rejects(get(route(() => response(200, { "content-type": "application/pdf" }))), refusal("not an HTML page (application/pdf)"));
  await assert.rejects(
    get(route(() => response(200, { "content-type": "text/html", "content-encoding": "zstd" }))),
    refusal("the page uses a content encoding this tool cannot read (zstd)"),
  );

  const page = "<p>Compressed page</p>";
  const gzip = await get(route(() => response(200, { "content-type": "application/xhtml+xml", "content-encoding": "gzip" }, [zlib.gzipSync(page)])));
  assert.equal(gzip.body.toString(), page);
  const brotli = await get(route(() => response(200, { "content-encoding": "br" }, [zlib.brotliCompressSync(page)])));
  assert.equal(brotli.body.toString(), page);

  // A server that never answers, and a DNS server that never answers: both stop at the time limit. A real socket or
  // lookup keeps the process running while it waits; these stand-ins do not, so an interval does it for them.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const hanging = (init) =>
      new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    await assert.rejects(get(route(hanging), { timeoutMs: 50 }), refusal("timed out after 0.05 s"));
    const slowDns = () => new Promise(() => {});
    await assert.rejects(
      fetchPage("http://slow.example/", { resolve: slowDns, transport: fakeTransport({}).transport, timeoutMs: 50 }),
      refusal("timed out after 0.05 s"),
    );
  } finally {
    clearInterval(keepAlive);
  }
});

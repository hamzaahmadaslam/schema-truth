// Fetches the pages named on the command line, and nothing else. Every hop (the URL given, then each redirect, at
// most 3) is checked before a connection is made: http or https only, and every address the host name resolves to
// must be public. The connection then goes only to those checked addresses, so a second DNS answer cannot swap in a
// private one. One time limit covers the whole page (10 s by default), the body stops at 2 MB, and the User-Agent
// names the tool.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const DEFAULT_TIMEOUT_MS = 10_000;

/** A page that could not be fetched. The message is written for the person running the tool. */
export class FetchError extends Error {
  constructor(message) {
    super(message);
    this.name = "FetchError";
  }
}

function ipv4ToNumber(ip) {
  const [a, b, c, d] = ip.split(".").map(Number);
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

/** Special-purpose IPv4 ranges (IANA registry, RFC 6890 and later). The single cloud metadata addresses come first. */
const V4_RANGES = [
  ["169.254.169.254/32", "metadata"], // AWS, Google Cloud, Azure and others
  ["169.254.170.2/32", "metadata"], // AWS container credentials
  ["100.100.100.200/32", "metadata"], // Alibaba Cloud
  ["192.0.0.192/32", "metadata"], // Oracle Cloud
  ["0.0.0.0/8", "unspecified"],
  ["10.0.0.0/8", "private"],
  ["100.64.0.0/10", "private"], // shared address space (carrier-grade NAT)
  ["127.0.0.0/8", "loopback"],
  ["169.254.0.0/16", "link-local"],
  ["172.16.0.0/12", "private"],
  ["192.0.0.0/24", "reserved"],
  ["192.0.2.0/24", "reserved"], // documentation
  ["192.88.99.0/24", "reserved"],
  ["192.168.0.0/16", "private"],
  ["198.18.0.0/15", "reserved"], // benchmarking
  ["198.51.100.0/24", "reserved"], // documentation
  ["203.0.113.0/24", "reserved"], // documentation
  ["224.0.0.0/4", "multicast"],
  ["240.0.0.0/4", "reserved"], // includes the broadcast address
].map(([cidr, reason]) => {
  const [base, bits] = cidr.split("/");
  const mask = (~0 << (32 - Number(bits))) >>> 0;
  return { base: (ipv4ToNumber(base) & mask) >>> 0, mask, reason };
});

function ipv4Reason(ip) {
  const n = ipv4ToNumber(ip);
  return V4_RANGES.find(({ base, mask }) => ((n & mask) >>> 0) === base)?.reason ?? null;
}

/** An IPv6 address as eight 16-bit numbers, or null. Handles "::", a zone ("%eth0") and a dotted IPv4 tail. */
function ipv6Groups(ip) {
  let text = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const tailStart = text.lastIndexOf(":") + 1;
  const tail = text.slice(tailStart);
  if (tail.includes(".")) {
    if (!net.isIPv4(tail)) return null;
    const n = ipv4ToNumber(tail);
    text = `${text.slice(0, tailStart)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

function ipv6Reason(ip) {
  const g = ipv6Groups(ip);
  if (!g) return "invalid";
  const zeros = (from, to) => g.slice(from, to).every((group) => group === 0);
  const embedded = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (zeros(0, 8)) return "unspecified";
  if (zeros(0, 7) && g[7] === 1) return "loopback";
  if (zeros(0, 5) && g[5] === 0xffff) return ipv4Reason(embedded()); // IPv4-mapped
  if (zeros(0, 6)) return "reserved"; // IPv4-compatible, deprecated
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return ipv4Reason(embedded()); // NAT64 (RFC 6052)
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return "private"; // local-use NAT64
  if (g[0] === 0x100 && zeros(1, 4)) return "reserved"; // discard-only
  if (g[0] === 0xfd00 && g[1] === 0x0ec2 && zeros(2, 7) && g[7] === 0x254) return "metadata"; // AWS, fd00:ec2::254
  if ((g[0] & 0xfe00) === 0xfc00) return "private"; // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((g[0] & 0xffc0) === 0xfec0) return "private"; // site-local, deprecated
  if ((g[0] & 0xff00) === 0xff00) return "multicast";
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "reserved"; // documentation
  if (g[0] === 0x3fff && g[1] < 0x1000) return "reserved"; // documentation
  if (g[0] === 0x2001 && g[1] < 0x0200) return "reserved"; // protocol assignments, including Teredo
  if (g[0] === 0x2002) return "reserved"; // 6to4
  if ((g[0] & 0xe000) !== 0x2000) return "reserved"; // outside global unicast 2000::/3
  return null;
}

/**
 * Why an address must not be fetched ("loopback", "private", "link-local", "metadata", "unspecified", "multicast",
 * "reserved" or "invalid"), or null for a public address.
 */
export function blockedReason(address) {
  const ip = String(address).replace(/^\[|\]$/g, "");
  const bare = ip.replace(/%.*$/, "");
  if (net.isIPv4(bare)) return ipv4Reason(bare);
  if (net.isIPv6(bare)) return ipv6Reason(ip);
  return "invalid";
}

const REASON_TEXT = {
  loopback: "a loopback address",
  private: "a private network address",
  "link-local": "a link-local address",
  metadata: "a cloud metadata address",
  unspecified: "an unspecified address",
  multicast: "a multicast address",
  reserved: "a reserved address",
  invalid: "an address that cannot be checked",
};

/** Parses a URL the tool may fetch: http or https only. */
export function parseHttpUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new FetchError("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchError(`only http and https URLs are fetched, not ${url.protocol.slice(0, -1)}`);
  }
  url.hash = "";
  return url;
}

const defaultResolve = (hostname) => dns.promises.lookup(hostname, { all: true });

/** Rejects when `signal` aborts, so a DNS lookup cannot outlast the time limit. */
function withSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The addresses for a URL's host, each one checked. An IP address in the URL is checked as it is. */
async function checkedAddresses(url, resolve, signal) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  if (net.isIP(host)) {
    addresses = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      addresses = await withSignal(Promise.resolve(resolve(host)), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new FetchError(`could not resolve the host name ${host} (${error?.code ?? error?.message ?? error})`);
    }
    if (!Array.isArray(addresses) || !addresses.length) throw new FetchError(`could not resolve the host name ${host}`);
  }
  for (const { address } of addresses) {
    const reason = blockedReason(address);
    if (reason) {
      const where = address === host ? host : `${host} resolves to ${address}, which`;
      throw new FetchError(`refused: ${where} is ${REASON_TEXT[reason]}`);
    }
  }
  return addresses.map(({ address }) => ({ address, family: net.isIP(address) }));
}

/** A dns.lookup stand-in for the connection: it answers only with the addresses already checked. */
export function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const family = options?.family === "IPv4" ? 4 : options?.family === "IPv6" ? 6 : options?.family;
    const wanted = family === 4 || family === 6 ? addresses.filter((entry) => entry.family === family) : addresses;
    if (!wanted.length) {
      const error = new Error(`no checked address for ${hostname}`);
      error.code = "ENOTFOUND";
      return process.nextTick(callback, error);
    }
    if (options?.all) process.nextTick(callback, null, wanted.map((entry) => ({ ...entry })));
    else process.nextTick(callback, null, wanted[0].address, wanted[0].family);
  };
}

/** One GET with Node's http or https client, connecting through `lookup`. Resolves with the response stream. */
function nodeTransport(url, { headers, lookup, signal }) {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(url, { method: "GET", headers, lookup, agent: false, signal }, resolve);
    request.on("error", reject);
    request.end();
  });
}

const DECODERS = {
  identity: null,
  gzip: () => zlib.createGunzip(),
  "x-gzip": () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
};
/** A byte count for messages: "1000 bytes", "512 KB", "2 MB". */
function size(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

async function readBody(response, maxBytes, signal) {
  const encoding = String(response.headers["content-encoding"] ?? "identity").trim().toLowerCase() || "identity";
  if (!Object.hasOwn(DECODERS, encoding)) {
    response.destroy();
    throw new FetchError(`the page uses a content encoding this tool cannot read (${encoding})`);
  }
  const chunks = [];
  let received = 0;
  const collect = new Writable({
    write(chunk, _encoding, done) {
      received += chunk.length;
      if (received > maxBytes) return done(new FetchError(`the page is larger than ${size(maxBytes)}`));
      chunks.push(chunk);
      done();
    },
  });
  const decoder = DECODERS[encoding]?.();
  try {
    await pipeline(...(decoder ? [response, decoder, collect] : [response, collect]), { signal });
  } catch (error) {
    if (error instanceof FetchError || signal.aborted) throw error;
    if (decoder && /^(Z_|ERR_BROTLI|ERR__)/.test(String(error?.code))) throw new FetchError(`the page could not be decompressed (${encoding})`);
    throw error;
  }
  return Buffer.concat(chunks);
}

const NETWORK_ERRORS = {
  ECONNREFUSED: "the connection was refused",
  ECONNRESET: "the connection was reset",
  ETIMEDOUT: "the connection timed out",
  EHOSTUNREACH: "the host could not be reached",
  ENETUNREACH: "the network could not be reached",
  EPROTO: "the TLS connection failed",
};

function describeError(error) {
  const code = error?.code;
  if (NETWORK_ERRORS[code]) return NETWORK_ERRORS[code];
  if (/CERT|SELF_SIGNED|ALTNAME|TLS|SSL/.test(String(code))) return `the TLS certificate was not accepted (${code})`;
  return code ? `${error.message} (${code})` : String(error?.message ?? error);
}

/**
 * Fetches one page. Returns { url, contentType, body } where `url` is the address after redirects and `body` a
 * Buffer, or throws a FetchError with a plain message. `resolve` (host name to [{ address, family }]) and
 * `transport` (one GET) are injectable, so tests run without DNS or a network.
 */
export async function fetchPage(input, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = MAX_BYTES,
    maxRedirects = MAX_REDIRECTS,
    userAgent = "schema-truth",
    resolve = defaultResolve,
    transport = nodeTransport,
  } = options;
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = {
    "user-agent": userAgent,
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    "accept-encoding": "gzip, deflate, br",
  };
  let url = parseHttpUrl(input);
  try {
    for (let redirects = 0; ; redirects++) {
      const addresses = await checkedAddresses(url, resolve, signal);
      const response = await transport(url, { headers, lookup: pinnedLookup(addresses), signal });
      const status = response.statusCode;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.destroy();
        if (redirects >= maxRedirects) throw new FetchError(`stopped after ${maxRedirects} redirects`);
        let next;
        try {
          next = new URL(location, url);
        } catch {
          throw new FetchError("the server redirected to an address that is not a valid URL");
        }
        url = parseHttpUrl(next.href);
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        throw new FetchError(`the server answered HTTP ${status}`);
      }
      const contentType = String(response.headers["content-type"] ?? "");
      if (contentType && !/^\s*(?:text\/html|application\/xhtml\+xml)\s*(?:;|$)/i.test(contentType)) {
        response.destroy();
        throw new FetchError(`not an HTML page (${contentType.split(";")[0].trim()})`);
      }
      if (Number(response.headers["content-length"]) > maxBytes) {
        response.destroy();
        throw new FetchError(`the page is larger than ${size(maxBytes)}`);
      }
      return { url: url.href, contentType, body: await readBody(response, maxBytes, signal) };
    }
  } catch (error) {
    if (error instanceof FetchError) throw error;
    if (signal.aborted) throw new FetchError(`timed out after ${timeoutMs / 1000} s`);
    throw new FetchError(describeError(error));
  }
}

// Reads the input: URLs to fetch, saved HTML files, or folders of them. Each becomes a page with its JSON-LD, its
// visible text and its claims, or with the reason it could not be read.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { extractClaims } from "./claims.mjs";
import { UserError } from "./errors.mjs";
import { DEFAULT_TIMEOUT_MS, fetchPage, FetchError, parseHttpUrl } from "./fetch.mjs";
import { decodeHtml, parseHtml, readJsonLd } from "./html.mjs";
import { USER_AGENT } from "./version.mjs";

export const HTML_EXTENSIONS = [".html", ".htm", ".xhtml"];
const CONCURRENCY = 4;

/** "https://...", "http://..." and any other "scheme://" count as URLs; everything else is a path. */
export const isUrl = (arg) => /^[a-z][a-z0-9+.-]+:\/\//i.test(arg);

const isHtmlPath = (file) => HTML_EXTENSIONS.includes(path.extname(file).toLowerCase());

/** Every HTML file below `root`, skipping node_modules and folders whose names start with a dot, in path order. */
export function listHtmlFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && isHtmlPath(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found
    .map((full) => ({ full, relative: path.relative(root, full).split(path.sep).join("/") }))
    .sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}

/**
 * Turns the command line arguments into a list of inputs in order: { kind: "url", source } or
 * { kind: "file", source, full }. A folder given alone names its pages relative to itself; alongside other inputs,
 * with the folder in front. Missing paths and non-HTML files are usage errors.
 */
export function listInputs(args) {
  const inputs = [];
  for (const arg of args) {
    if (isUrl(arg)) {
      try {
        parseHttpUrl(arg);
      } catch (error) {
        throw new UserError(`${arg}: ${error.message}.`);
      }
      inputs.push({ kind: "url", source: arg });
      continue;
    }
    let stat;
    try {
      stat = statSync(arg);
    } catch {
      const looksLikeHost = /^(?:www\.|[\w-]+(?:\.[\w-]+)+\/)/i.test(arg);
      throw new UserError(
        `Cannot read ${arg}: there is no such file or folder.${looksLikeHost ? " For a web page, start the URL with https://." : ""}`,
      );
    }
    if (stat.isDirectory()) {
      const files = listHtmlFiles(arg);
      if (!files.length) throw new UserError(`${arg} has no ${HTML_EXTENSIONS.join(", ")} files.`);
      const prefix = args.length === 1 ? "" : `${arg.split(path.sep).join("/").replace(/\/+$/, "")}/`;
      for (const { full, relative } of files) inputs.push({ kind: "file", source: `${prefix}${relative}`, full });
    } else if (isHtmlPath(arg)) {
      inputs.push({ kind: "file", source: args.length === 1 ? path.basename(arg) : arg.split(path.sep).join("/"), full: arg });
    } else {
      throw new UserError(`${arg} is not a URL, an HTML file (${HTML_EXTENSIONS.join(", ")}) or a folder.`);
    }
  }
  return inputs;
}

/**
 * What the tool knows about one page: its JSON-LD blocks (parsed or not), the types at the top of the markup, its
 * visible text and the claims to check.
 */
export function readPage(source, html, extra = {}) {
  const { text, blocks } = parseHtml(html);
  const parsed = readJsonLd(blocks);
  const { claims, types } = extractClaims(parsed);
  return { source, ...extra, error: null, blocks: parsed, types, text, claims };
}

/** Runs `worker` over `items`, at most `limit` at a time, keeping the order; starts nothing new after a failure. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * Loads every input: reads files, fetches URLs (four at a time). A URL that cannot be fetched becomes a page with an
 * `error` instead of stopping the run. `resolve` and `transport` are passed to fetchPage for tests.
 */
export async function loadPages(inputs, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, resolve, transport, onProgress } = options;
  let done = 0;
  return mapLimit(inputs, CONCURRENCY, async (input) => {
    let page;
    if (input.kind === "file") {
      page = readPage(input.source, decodeHtml(readFileSync(input.full)), { kind: "file", url: null });
    } else {
      try {
        const fetched = await fetchPage(input.source, { timeoutMs, resolve, transport, userAgent: USER_AGENT });
        page = readPage(input.source, decodeHtml(fetched.body, fetched.contentType), { kind: "url", url: fetched.url });
      } catch (error) {
        if (!(error instanceof FetchError)) throw error;
        page = { source: input.source, kind: "url", url: null, error: error.message, blocks: [], types: [], text: "", claims: [] };
      }
    }
    onProgress?.(++done, inputs.length);
    return page;
  });
}

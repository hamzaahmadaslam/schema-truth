import { readFileSync } from "node:fs";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** Sent with every page request, so site owners can see what fetched their page. */
export const USER_AGENT = `schema-truth/${VERSION} (+https://github.com/hamzaahmadaslam/schema-truth)`;

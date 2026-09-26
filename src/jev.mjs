// A small client for TypeSafe's System One API (Jev). Copy this file into a tool as src/jev.mjs.
// API: POST https://api.typesafe.ai/v1/systemone  { model, state, questions }  -> { model, answers, usage }
// The key comes from TYPESAFE_API_KEY and is only ever sent in the Authorization header.

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";

export class JevError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "JevError";
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks Jev the `questions` about `state`. Retries 429 and 529 up to `retries` times with exponential backoff
 * (honouring retry-after), times out each attempt after `timeoutMs`, and throws a JevError with a plain message
 * otherwise. `fetchImpl` is injectable so tests never touch the network.
 */
export async function askJev(state, questions, options = {}) {
  const {
    apiKey = process.env.TYPESAFE_API_KEY,
    model = process.env.TYPESAFE_MODEL || DEFAULT_MODEL,
    timeoutMs = 10_000,
    retries = 3,
    fetchImpl = globalThis.fetch,
  } = options;
  if (!apiKey || !apiKey.trim()) {
    throw new JevError("TYPESAFE_API_KEY is not set. Get a key at https://typesafe.ai and export it first.", 0);
  }
  const body = JSON.stringify({ model, state, questions });
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey.trim()}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new JevError(`Could not reach TypeSafe: ${error?.name === "TimeoutError" ? "timed out" : error?.message}`, 0);
    }
    if (res.ok) {
      const data = await res.json();
      if (!data || typeof data.answers !== "object") throw new JevError("TypeSafe answered without answers.", res.status);
      return data;
    }
    if ((res.status === 429 || res.status === 529) && attempt < retries) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt);
      continue;
    }
    const detail = await res.text().catch(() => "");
    const reason =
      res.status === 401
        ? "the API key was refused"
        : res.status === 422
          ? `the request was invalid: ${detail.slice(0, 300)}`
          : res.status === 429
            ? "rate limited; try again later"
            : res.status === 529
              ? "TypeSafe is overloaded; try again later"
              : `HTTP ${res.status}`;
    throw new JevError(`TypeSafe error: ${reason}`, res.status);
  }
}

/** Question helpers (the shapes in reference/typesafe/api.md). */
export const noul = (instructions, criteria) => ({ type: "noul", instructions, ...(criteria ? { criteria } : {}) });
export const choice = (instructions, options) => ({ type: "choice", instructions, criteria: options });
export const score = (instructions, levels) => ({ type: "score", instructions, criteria: levels });

/** A fetch stand-in for tests: answers each request with `respond(body)` (a plain object) or an error status. */
export function fixtureFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const out = await respond(body, calls.length);
    if (typeof out === "number") return new Response(JSON.stringify({ error: "fixture" }), { status: out });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

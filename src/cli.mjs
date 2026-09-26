// The command line: parses options, reads the pages, and prints the report, the JSON or the dry run.
// main() takes its environment, output streams, fetch and page transport as arguments, so tests run it offline.
import { parseArgs } from "node:util";
import { DEFAULT_THRESHOLD, DEFAULT_TIMEOUT_SECONDS, planRequests, runPlan } from "./check.mjs";
import { UserError } from "./errors.mjs";
import { DEFAULT_MODEL, JevError } from "./jev.mjs";
import { listInputs, loadPages } from "./load.mjs";
import { dryRunJson, formatDryRun, formatReport, toJson } from "./report.mjs";
import { VERSION } from "./version.mjs";

export { VERSION };

export const USAGE = `Usage: schema-truth <url | page.html | folder>... [options]

Checks whether the values in a page's JSON-LD (prices, availability, ratings, reviews, authors, dates, headlines,
FAQ answers, addresses and phone numbers) are shown in the text a visitor sees.

Options:
  --threshold <p>      probability needed to call a claim supported or unsupported, above 0.5 and up to 1 (default ${DEFAULT_THRESHOLD})
  --timeout <seconds>  time limit for each page and each TypeSafe request (default ${DEFAULT_TIMEOUT_SECONDS})
  --json               print JSON instead of the report
  --dry-run            read the pages and print the claims and a token estimate; send nothing to TypeSafe
  -h, --help           show this help
  -v, --version        show the version

Environment:
  TYPESAFE_API_KEY     your TypeSafe API key (not needed for --dry-run)
  TYPESAFE_MODEL       the model to use (default ${DEFAULT_MODEL})

Exit codes: 0 no unsupported claim, 1 at least one unsupported claim, 2 an error or a page that could not be read.
`;

function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        threshold: { type: "string" },
        timeout: { type: "string" },
        json: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    throw new UserError(`${error.message} Run schema-truth --help for the options.`);
  }
  const { values, positionals } = parsed;
  if (values.help || values.version) return { help: values.help, version: values.version };
  if (!positionals.length) {
    throw new UserError("Give at least one URL, saved HTML file or folder to check. Run schema-truth --help for usage.");
  }
  const threshold = values.threshold === undefined ? DEFAULT_THRESHOLD : Number(values.threshold);
  if (!(threshold > 0.5 && threshold <= 1)) {
    throw new UserError(`--threshold must be a number above 0.5 and at most 1, not "${values.threshold}".`);
  }
  const timeoutSeconds = values.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(values.timeout);
  if (!(timeoutSeconds > 0 && timeoutSeconds <= 600)) {
    throw new UserError(`--timeout must be a number of seconds above 0 and at most 600, not "${values.timeout}".`);
  }
  return { inputs: positionals, threshold, timeoutSeconds, json: values.json, dryRun: values["dry-run"] };
}

/**
 * Runs the tool. Returns the exit code: 0 no unsupported claim, 1 at least one unsupported claim, 2 an error or a
 * page that could not be read.
 */
export async function main(argv, io = {}) {
  const {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    fetchImpl = globalThis.fetch,
    resolve,
    transport,
  } = io;
  const write = (stream, text) => stream.write(text.endsWith("\n") ? text : `${text}\n`);
  try {
    const options = parseOptions(argv);
    if (options.help || options.version) {
      write(stdout, options.help ? USAGE : VERSION);
      return 0;
    }
    const inputs = listInputs(options.inputs);
    const progress = (verb) =>
      stderr.isTTY ? (done, total) => stderr.write(`\r${verb} ${done} of ${total}${done === total ? "\n" : ""}`) : undefined;
    const pages = await loadPages(inputs, {
      timeoutMs: options.timeoutSeconds * 1000,
      resolve,
      transport,
      onProgress: inputs.some((input) => input.kind === "url") ? progress("read page") : undefined,
    });
    const model = env.TYPESAFE_MODEL?.trim() || DEFAULT_MODEL;
    const meta = { version: VERSION, model };
    const plan = planRequests(pages, { model });
    const unread = pages.some((page) => page.error);

    if (options.dryRun) {
      write(stdout, options.json ? JSON.stringify(dryRunJson(plan, meta), null, 2) : formatDryRun(plan, meta));
      return unread ? 2 : 0;
    }

    const apiKey = env.TYPESAFE_API_KEY?.trim();
    if (plan.requests.length && !apiKey) {
      throw new UserError(
        "TYPESAFE_API_KEY is not set. Get a key at https://typesafe.ai and export it first, or use --dry-run to see what would be sent.",
      );
    }
    const result = await runPlan(plan, {
      threshold: options.threshold,
      apiKey,
      model,
      timeoutSeconds: options.timeoutSeconds,
      fetchImpl,
      onProgress: progress("request"),
    });
    write(stdout, options.json ? JSON.stringify(toJson(result, meta), null, 2) : formatReport(result));
    if (unread) return 2;
    return result.summary.unsupported > 0 ? 1 : 0;
  } catch (error) {
    const known = error instanceof UserError || error instanceof JevError;
    write(stderr, `schema-truth: ${known ? error.message : `unexpected error: ${error?.message ?? error}`}`);
    return 2;
  }
}

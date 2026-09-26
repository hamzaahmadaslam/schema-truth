// Reproduces the README example without a TypeSafe key: runs schema-truth on examples/pages and answers every
// question from the hand-written probabilities in fixture-answers.json. Nothing leaves the machine.
//   node examples/run.mjs              the report (examples/report.txt)
//   node examples/run.mjs --json       the JSON (examples/report.json)
//   node examples/run.mjs --dry-run    the dry run (examples/dry-run.txt)
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { estimateTokens } from "../src/check.mjs";
import { main } from "../src/cli.mjs";
import { fixtureFetch } from "../src/jev.mjs";
import { listInputs, loadPages } from "../src/load.mjs";

export const PAGES = fileURLToPath(new URL("./pages", import.meta.url));
const FIXTURE = JSON.parse(readFileSync(new URL("./fixture-answers.json", import.meta.url), "utf8"));

/**
 * A fetch stand-in that answers from fixture-answers.json. Requests carry no page names, so the page is found by
 * its visible text, which is the state of every request for that page.
 */
export async function exampleFetch() {
  const pages = await loadPages(listInputs([PAGES]));
  const byText = new Map(pages.map((page) => [page.text, page.source]));
  return fixtureFetch((body) => {
    const source = byText.get(body.state.visible_text);
    const table = FIXTURE.answers[source];
    if (!table) throw new Error(`No fixture answers for the page with this text: ${body.state.visible_text.slice(0, 60)}`);
    const answers = {};
    for (const id of Object.keys(body.questions)) {
      if (typeof table[id] !== "number") throw new Error(`No fixture answer for ${source} ${id}.`);
      answers[id] = { type: "noul", noul: table[id] };
    }
    return { model: FIXTURE.model, answers, usage: { input_tokens: estimateTokens(JSON.stringify(body)), output_tokens: 0 } };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = process.argv.slice(2).filter((flag) => flag === "--json" || flag === "--dry-run");
  process.exitCode = await main([PAGES, ...flags], {
    env: { TYPESAFE_API_KEY: "fixture" },
    fetchImpl: (await exampleFetch()).fetchImpl,
  });
}

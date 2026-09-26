import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import test from "node:test";
import { decodeEntities, decodeHtml, fragmentText, parseHtml, readJsonLd } from "../src/html.mjs";

// Any attempt to reach the network fails loudly: TypeSafe through fetch, a page through DNS, http or https.
const offline = () => {
  throw new Error("Tests must not use the network.");
};
globalThis.fetch = offline;
dns.lookup = dns.promises.lookup = offline;
http.request = http.get = https.request = https.get = offline;

test("JSON-LD: every ld+json script with its line, wrappers removed, bad blocks reported, other scripts ignored", () => {
  const html = [
    "<!doctype html><html><head>",
    '<script type="application/ld+json">{"@type": "Product", "name": "A"}</script>',
    '<script type="application/ld+json; charset=utf-8">',
    "<!--",
    '{"@type": "Organization"}',
    "-->",
    "</script>",
    '<script type="application/ld+json">//<![CDATA[',
    '[{"@type": "Person"}];',
    "//]]></script>",
    "<script>var s = '<script type=\"application/ld+json\">{}</' + 'script>';</script>",
    '<script type="text/template"><div>not a tag</div></script>',
    '<!-- <script type="application/ld+json">{"@type": "Commented"}</script> -->',
    '<script type="APPLICATION/LD+JSON">{"@type": "Thing",}</script>',
    '<script type="application/ld+json">   </script>',
    "</head><body><p>Text</p></body></html>",
  ].join("\n");
  const { blocks, text } = parseHtml(html);
  assert.deepEqual(
    blocks.map((block) => block.line),
    [2, 3, 8, 14, 15],
  );
  assert.deepEqual(readJsonLd(blocks), [
    { index: 1, line: 2, data: { "@type": "Product", name: "A" } },
    { index: 2, line: 3, data: { "@type": "Organization" } },
    { index: 3, line: 8, data: [{ "@type": "Person" }] },
    { index: 4, line: 14, error: "invalid" },
    { index: 5, line: 15, error: "empty" },
  ]);
  assert.equal(text, "Text");
});

test("visible text leaves out scripts, styles, the head, templates, hidden and display:none elements", () => {
  const html = `<html><head><title>Title is not page text</title><style>p { color: red }</style></head><body>
    <noscript>Turn on JavaScript</noscript>
    <h1>Shown heading</h1>
    <p hidden>Hidden by attribute</p>
    <div style="color: red; display : none !important"><p>Hidden by style</p></div>
    <span style="visibility:hidden">Invisible</span>
    <template><p>Template content</p></template>
    <dialog><p>Closed dialog</p></dialog>
    <dialog open><p>Open dialog</p></dialog>
    <svg><title>Icon title</title><text>Drawing</text></svg>
    <iframe>Frame fallback</iframe>
    <p aria-hidden="true">Decorative but visible</p>
    <input type="hidden" value="secret">
    <p hidden="until-found">Found by search</p>
    <details><summary>Question</summary><p>Collapsed answer</p></details>
    <script>document.write("Script text")</script>
  </body></html>`;
  assert.equal(
    parseHtml(html).text,
    [
      "Shown heading",
      "Open dialog",
      "Decorative but visible",
      "Found by search",
      "Question",
      "Collapsed answer",
    ].join("\n"),
  );
});

test("visible text keeps lines, table rows, image alt text and entities; implied end tags close hidden elements", () => {
  const html = `<main>
    <p>Price: <b>&euro;49&nbsp;00</b> &amp; &#8364;5 &#x20AC;6<br>Second line</p>
    <table><tr><th>Size</th><td>8</td><tr><td hidden>9</td><td>10</td></table>
    <img src="stars.png" alt="Rated 4.5 out of 5"><img src="spacer.gif" alt=""><img hidden alt="Hidden image">
    <ul><li hidden>Old price $99<li>New price $79</ul>
    <p hidden>Hidden paragraph<p>Next paragraph is shown
    <div hidden><p>Inner</div><p>After the hidden div</p>
    <p>A < B and 3 &lt; 4</p>
  </main>`;
  assert.equal(
    parseHtml(html).text,
    [
      "Price: €49 00 & €5 €6",
      "Second line",
      "Size | 8",
      "10",
      "[image: Rated 4.5 out of 5]",
      "New price $79",
      "Next paragraph is shown",
      "After the hidden div",
      "A < B and 3 < 4",
    ].join("\n"),
  );
  assert.equal(fragmentText("<p>Yes, <b>within</b> 30 days.</p><p>Unworn only.</p>"), "Yes, within 30 days. Unworn only.");
  assert.equal(fragmentText("Tom &amp;  Jerry"), "Tom & Jerry");
});

test("character references: the Latin-1 table, Windows-1252 numbers, bad numbers, unknown names", () => {
  assert.equal(decodeEntities("&nbsp;&copy;&times;&divide;&yuml;&Agrave;&szlig;"), " ©×÷ÿÀß");
  assert.equal(decodeEntities("&#150; &#128; &#146;"), "– € ’");
  assert.equal(decodeEntities("&#0; &#xD800; &#1114112;"), "� � �");
  assert.equal(decodeEntities("&starf;&star; &bogus; AT&T &amp"), "★☆ &bogus; AT&T &amp");
});

test("decodeHtml: byte order mark, Content-Type charset, <meta> charset, then UTF-8", () => {
  const latin1 = (text) => Buffer.from(text, "latin1");
  assert.equal(decodeHtml(Buffer.from("\uFEFFcafé", "utf8")), "café");
  assert.equal(decodeHtml(latin1("price \x80 5"), "text/html; charset=windows-1252"), "price € 5");
  assert.equal(decodeHtml(latin1('<meta charset="iso-8859-1"><p>caf\xe9</p>')), '<meta charset="iso-8859-1"><p>café</p>');
  assert.equal(
    decodeHtml(latin1('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">\x93quoted\x94')),
    '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">“quoted”',
  );
  assert.equal(decodeHtml(Buffer.from('<meta charset="utf-16"><p>café</p>', "utf8")), '<meta charset="utf-16"><p>café</p>');
  assert.equal(decodeHtml(Buffer.from("<p>café</p>", "utf8"), "text/html; charset=no-such-charset"), "<p>café</p>");
});

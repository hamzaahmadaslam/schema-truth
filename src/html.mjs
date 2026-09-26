// Reads HTML in code: the JSON-LD blocks, and the text a visitor sees. Nothing on the page runs: scripts are not
// executed and stylesheets are not loaded, so only HTML attributes and inline styles can hide an element.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

/** Elements whose content is raw text that ends only at the matching end tag. None of it is text a visitor reads. */
const RAW_TEXT = new Set(["script", "style", "title", "textarea", "iframe", "noembed", "noframes", "noscript", "xmp"]);

/** Elements whose content is never shown as page text: inert templates, media fallbacks, drawings. */
const NOT_SHOWN = new Set(["template", "svg", "object", "canvas", "audio", "video", "datalist"]);

/** Elements that start a new line of text. */
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "caption", "center", "dd", "details", "dialog", "dir", "div", "dl",
  "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
  "hr", "legend", "li", "main", "menu", "nav", "ol", "optgroup", "option", "p", "pre", "search", "section", "summary",
  "table", "tbody", "tfoot", "thead", "tr", "ul",
]);
const CELL = new Set(["td", "th"]);

/** Opening one of these closes an open <p>, as browsers do. */
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "center", "dd", "details", "dialog", "dir", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr",
  "li", "main", "menu", "nav", "ol", "p", "pre", "search", "section", "summary", "table", "ul", "xmp",
]);
const SCOPE = new Set(["button", "table", "td", "th", "caption", "template", "object", "marquee", "applet", "svg", "math"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** For elements whose end tag is optional: which open elements a new one closes, and where the search stops. */
const IMPLIED = {
  li: { closes: ["li"], stops: ["ul", "ol", "menu", ...SCOPE] },
  dt: { closes: ["dt", "dd"], stops: ["dl", ...SCOPE] },
  dd: { closes: ["dt", "dd"], stops: ["dl", ...SCOPE] },
  tr: { closes: ["tr"], stops: ["table"] },
  td: { closes: ["td", "th"], stops: ["tr", "table"] },
  th: { closes: ["td", "th"], stops: ["tr", "table"] },
  thead: { closes: ["thead", "tbody", "tfoot"], stops: ["table"] },
  tbody: { closes: ["thead", "tbody", "tfoot"], stops: ["table"] },
  tfoot: { closes: ["thead", "tbody", "tfoot"], stops: ["table"] },
  option: { closes: ["option"], stops: ["select", "datalist", "optgroup"] },
  optgroup: { closes: ["option", "optgroup"], stops: ["select", "datalist"] },
};

// Named character references: the HTML 4 set (Latin-1, symbols, punctuation) and a few HTML5 ones seen in prices
// and ratings. Anything else is left as written.
const LATIN1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute " +
  "micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig " +
  "Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash " +
  "Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc " +
  "euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml " +
  "yacute thorn yuml";
const NAMED = {
  quot: 34, amp: 38, apos: 39, lt: 60, gt: 62, OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376,
  fnof: 402, circ: 710, tilde: 732, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206,
  rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221,
  bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243,
  lsaquo: 8249, rsaquo: 8250, euro: 8364, trade: 8482, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595,
  minus: 8722, infin: 8734, ne: 8800, le: 8804, ge: 8805, starf: 9733, star: 9734, check: 10003, half: 189,
};
LATIN1.split(" ").forEach((name, i) => (NAMED[name] = 160 + i));

/** What browsers show for numeric references 128 to 159, which old pages use for Windows-1252 characters. */
const WINDOWS_1252 = {
  128: 8364, 130: 8218, 131: 402, 132: 8222, 133: 8230, 134: 8224, 135: 8225, 136: 710, 137: 8240, 138: 352,
  139: 8249, 140: 338, 142: 381, 145: 8216, 146: 8217, 147: 8220, 148: 8221, 149: 8226, 150: 8211, 151: 8212,
  152: 732, 153: 8482, 154: 353, 155: 8250, 156: 339, 158: 382, 159: 376,
};

function codePoint(n) {
  if (WINDOWS_1252[n]) return String.fromCodePoint(WINDOWS_1252[n]);
  if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "�";
  return String.fromCodePoint(n);
}

/** Decodes character references such as &amp;, &#8364; and &#x20AC;. Unknown names are left as they are. */
export function decodeEntities(text) {
  if (!text.includes("&")) return text;
  return text.replace(/&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([a-zA-Z][a-zA-Z0-9]{1,31});)/g, (match, dec, hex, name) => {
    if (dec !== undefined) return codePoint(Number(dec));
    if (hex !== undefined) return codePoint(parseInt(hex, 16));
    return Object.hasOwn(NAMED, name) ? String.fromCodePoint(NAMED[name]) : match;
  });
}

const isSpace = (code) => code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
const isLetter = (code) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/**
 * Reads one tag starting at `lt` (the "<"). Returns { end, name, closing, attrs } or null when the "<" does not
 * start a tag, in which case it is plain text. Attribute names are lower-cased and values decoded.
 */
function readTag(html, lt) {
  let i = lt + 1;
  const closing = html.charCodeAt(i) === 47; // "/"
  if (closing) i++;
  if (!isLetter(html.charCodeAt(i))) return null;
  const nameStart = i;
  while (i < html.length && !isSpace(html.charCodeAt(i)) && html[i] !== "/" && html[i] !== ">") i++;
  const name = html.slice(nameStart, i).toLowerCase();
  const attrs = {};
  while (i < html.length) {
    const c = html[i];
    if (c === ">") return { end: i + 1, name, closing, attrs };
    if (c === "/" || isSpace(html.charCodeAt(i))) {
      i++;
      continue;
    }
    const attrStart = i;
    while (i < html.length && !isSpace(html.charCodeAt(i)) && !"/>=".includes(html[i])) i++;
    if (i === attrStart) {
      i++; // a stray "="
      continue;
    }
    const attrName = html.slice(attrStart, i).toLowerCase();
    while (isSpace(html.charCodeAt(i))) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (isSpace(html.charCodeAt(i))) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        if (close === -1) return { end: html.length, name, closing, attrs };
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const valueStart = i;
        while (i < html.length && !isSpace(html.charCodeAt(i)) && html[i] !== ">") i++;
        value = html.slice(valueStart, i);
      }
    }
    if (!Object.hasOwn(attrs, attrName)) attrs[attrName] = decodeEntities(value);
  }
  return { end: html.length, name, closing, attrs };
}

/** Whether an element and everything inside it is kept out of the visible text. */
function hides(name, attrs) {
  if (NOT_SHOWN.has(name)) return true;
  if (name === "dialog" && !Object.hasOwn(attrs, "open")) return true;
  if (Object.hasOwn(attrs, "hidden") && attrs.hidden.trim().toLowerCase() !== "until-found") return true;
  const style = attrs.style ?? "";
  return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!\s*important\s*)?(?:;|$)/i.test(style);
}

const JSON_LD_TYPE = /^\s*application\/ld\+json\s*(?:;.*)?$/i;

/**
 * Reads an HTML document. Returns { text, blocks }: the text a visitor sees, one line per block of the page (table
 * cells joined with " | ", image alt text as "[image: ...]"), and every <script type="application/ld+json"> as
 * { index, line, raw }, where `line` is the line of the file where the script's content starts.
 */
export function parseHtml(html) {
  const pieces = [];
  const blocks = [];
  const stack = [];
  let hidden = 0;
  let scanned = 0;
  let line = 1;
  const lineAt = (offset) => {
    for (; scanned < offset; scanned++) if (html.charCodeAt(scanned) === 10) line++;
    return line;
  };
  const emit = (text) => {
    if (!hidden) pieces.push(text);
  };
  const pop = () => {
    const top = stack.pop();
    if (top.hidden) hidden--;
    if (top.block) emit("\n");
  };
  const popThrough = (index) => {
    while (stack.length > index) pop();
  };
  const find = (names, stops) => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (names.includes(stack[k].name)) return k;
      if (stops.includes(stack[k].name)) return -1;
    }
    return -1;
  };

  const open = (name, attrs) => {
    if (name === "html" || name === "head" || name === "body") return;
    if (CLOSES_P.has(name)) {
      const p = find(["p"], [...SCOPE]);
      if (p >= 0) popThrough(p);
    }
    if (HEADINGS.has(name) && HEADINGS.has(stack.at(-1)?.name)) pop();
    const rule = IMPLIED[name];
    if (rule) {
      const k = find(rule.closes, rule.stops);
      if (k >= 0) popThrough(k);
    }
    if (VOID.has(name)) {
      if (name === "br" || name === "hr") emit("\n");
      else if (name === "img" && attrs.alt?.trim() && !hides(name, attrs)) emit(` [image: ${attrs.alt.trim()}] `);
      return;
    }
    const isHidden = hides(name, attrs);
    const block = BLOCK.has(name);
    if (block) emit("\n");
    if (CELL.has(name)) emit("\u0001");
    stack.push({ name, hidden: isHidden, block });
    if (isHidden) hidden++;
  };

  const close = (name) => {
    if (name === "br") return emit("\n");
    const k = stack.findLastIndex((entry) => entry.name === name);
    if (k >= 0) popThrough(k);
    else if (name === "p") emit("\n");
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      emit(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) emit(decodeEntities(html.slice(i, lt)));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    const tag = readTag(html, lt);
    if (!tag) {
      emit("<");
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (tag.closing) {
      close(tag.name);
      continue;
    }
    if (RAW_TEXT.has(tag.name)) {
      const endTag = new RegExp(`</${tag.name}(?=[\\s/>])`, "ig");
      endTag.lastIndex = i;
      const found = endTag.exec(html);
      const contentEnd = found ? found.index : html.length;
      if (tag.name === "script" && JSON_LD_TYPE.test(tag.attrs.type ?? "")) {
        blocks.push({ index: blocks.length + 1, line: lineAt(i), raw: html.slice(i, contentEnd) });
      }
      const gt = found ? html.indexOf(">", contentEnd) : -1;
      i = gt === -1 ? html.length : gt + 1;
      continue;
    }
    open(tag.name, tag.attrs);
  }

  const text = pieces
    .join("")
    .split("\n")
    .map((row) =>
      row
        .split("\u0001")
        .map((cell) => cell.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" | "),
    )
    .filter(Boolean)
    .join("\n");
  return { text, blocks };
}

/** The text of an HTML fragment (a FAQ answer, say) on one line. */
export function fragmentText(fragment) {
  if (!fragment.includes("<")) return decodeEntities(fragment).replace(/\s+/g, " ").trim();
  return parseHtml(fragment).text.replace(/\s*\n\s*/g, " ").trim();
}

/** Strips what pages wrap JSON-LD in (HTML comments, CDATA markers, a trailing semicolon) around the JSON itself. */
function unwrap(raw) {
  let text = raw.replace(/^\uFEFF/, "").trim();
  let before;
  do {
    before = text;
    text = text
      .replace(/^<!--/, "")
      .replace(/-->$/, "")
      .replace(/^(?:\/\/[^\S\n]*)?<!\[CDATA\[/, "")
      .replace(/(?:\/\/[^\S\n]*)?\]\]>$/, "")
      .replace(/;$/, "")
      .trim();
  } while (text !== before);
  return text;
}

/**
 * Parses the JSON-LD blocks found by parseHtml. Each comes back as { index, line, data }, or as
 * { index, line, error } with error "empty" or "invalid" when there is nothing to parse or it is not valid JSON.
 */
export function readJsonLd(blocks) {
  return blocks.map(({ index, line, raw }) => {
    const text = unwrap(raw);
    if (!text) return { index, line, error: "empty" };
    try {
      return { index, line, data: JSON.parse(text) };
    } catch {
      return { index, line, error: "invalid" };
    }
  });
}

/** The charset named in a Content-Type header or in a <meta> tag near the top of the page, if any. */
function declaredCharset(bytes, contentType) {
  const fromHeader = /charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(contentType ?? "");
  if (fromHeader) return fromHeader[1];
  const head = Buffer.from(bytes.subarray(0, 4096)).toString("latin1");
  const fromMeta = /<meta[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  if (!fromMeta) return null;
  // A page that could be read as ASCII to find this tag cannot be UTF-16, whatever the tag says.
  return /^utf-?16/i.test(fromMeta[1]) ? "utf-8" : fromMeta[1];
}

/** Bytes to text: a byte order mark first, then the Content-Type charset, then a <meta> charset, else UTF-8. */
export function decodeHtml(bytes, contentType = "") {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  const label = declaredCharset(bytes, contentType) ?? "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

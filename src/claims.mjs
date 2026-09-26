// Turns the JSON-LD on a page into claims to check against the visible text: prices, availability, ratings and
// reviews, authors, dates, headlines, FAQ questions and answers, addresses and phone numbers. A claim names the
// item it belongs to, the property in plain words, the value as text, and where it sits in the markup.
import { decodeEntities, fragmentText } from "./html.mjs";

export const MAX_VALUE_CHARS = 1_000;
const MAX_NAME_CHARS = 120;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Types that are part of an item rather than an item: an offer's price is the price of its product. */
const PART_TYPES = new Set([
  "Offer", "AggregateOffer", "PriceSpecification", "UnitPriceSpecification", "CompoundPriceSpecification",
  "AggregateRating", "Rating", "Review", "PostalAddress", "ContactPoint", "Question", "Answer",
]);

/** Properties of the page as a whole: identical values are checked once, whichever item they sit on. */
const PAGE_LEVEL = new Set(["headline", "author", "date published", "date modified"]);

const DATES = [
  ["datePublished", "date published", false],
  ["dateModified", "date modified", false],
  ["startDate", "start date", true],
  ["endDate", "end date", true],
];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const asArray = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

/** "https://schema.org/Product" and "schema:Product" to "Product". */
function typeNames(node) {
  return asArray(node["@type"])
    .filter((type) => typeof type === "string")
    .map((type) => type.replace(/^https?:\/\/schema\.org\//i, "").replace(/^schema:/i, "").trim())
    .filter(Boolean);
}

/** Cuts long text at a word boundary. */
function cap(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 3);
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}...`;
}

/** A JSON-LD value as one line of text: strings decoded and trimmed, numbers as written, {"@value"} unwrapped. */
function textOf(value) {
  if (typeof value === "string") return decodeEntities(value).replace(/\s+/g, " ").trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (isObject(value) && "@value" in value) return textOf(value["@value"]);
  return "";
}

/** An ISO 8601 date as "2 March 2026" (with the time for events), so it reads the way pages write dates. */
export function dateInWords(value, withTime = false) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  const day = Number(match[3]);
  if (!month || day < 1 || day > 31) return value;
  const date = `${day} ${month} ${match[1]}`;
  return withTime && match[4] !== undefined ? `${date}, ${match[4]}:${match[5]}` : date;
}

/** "https://schema.org/InStock" to "in stock". */
export function availabilityInWords(value) {
  const name = value.replace(/^https?:\/\/schema\.org\//i, "").replace(/^schema:/i, "");
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/** A path inside a block, such as "@graph[1].offers.price". */
const join = (path, key) => (typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key);

/**
 * Walks the parsed JSON-LD blocks of one page and returns { claims, types }: the claims in markup order with ids
 * c1, c2 and so on, and the @type of each top-level item. Identical claims (same item, property and value) are kept
 * once with every path where they appear. Items linked by "@id" are followed within the page.
 */
export function extractClaims(blocks) {
  const definitions = new Map();
  const referenced = new Set();
  const roots = [];
  const collect = (value, block, path) => {
    if (Array.isArray(value)) return value.forEach((entry, i) => collect(entry, block, join(path, i)));
    if (!isObject(value)) return;
    const keys = Object.keys(value).filter((key) => key !== "@id" && key !== "@type" && key !== "@context");
    if (typeof value["@id"] === "string") {
      if (keys.length === 0) referenced.add(value["@id"]);
      else if (!definitions.has(value["@id"])) definitions.set(value["@id"], { node: value, block, path });
    }
    for (const [key, child] of Object.entries(value)) if (key !== "@context") collect(child, block, join(path, key));
  };
  for (const block of blocks) {
    if (block.data === undefined) continue;
    collect(block.data, block.index, "");
    const tops = Array.isArray(block.data) ? block.data.map((node, i) => [node, `[${i}]`]) : [[block.data, ""]];
    for (const [node, path] of tops) {
      if (!isObject(node)) continue;
      if (Array.isArray(node["@graph"])) node["@graph"].forEach((entry, i) => roots.push({ node: entry, block: block.index, path: join(join(path, "@graph"), i) }));
      if (node["@type"] !== undefined || !Array.isArray(node["@graph"])) roots.push({ node, block: block.index, path });
    }
  }

  const resolve = (value) => {
    if (!isObject(value) || typeof value["@id"] !== "string") return value;
    const own = Object.keys(value).filter((key) => key !== "@id" && key !== "@type");
    return own.length ? value : definitions.get(value["@id"])?.node ?? value;
  };
  const nameOf = (value) => {
    const node = resolve(value);
    if (typeof node === "string") return textOf(node);
    return isObject(node) ? textOf(node.name) : "";
  };
  const describe = (node) => {
    const name = cap(textOf(node.name) || textOf(node.headline), MAX_NAME_CHARS);
    const type = typeNames(node)[0];
    if (name) return type ? `${name} (${type})` : name;
    return type ?? "";
  };

  const claims = [];
  const byKey = new Map();
  const add = (item, property, value, block, path, raw) => {
    const text = cap(value, MAX_VALUE_CHARS);
    if (!text) return;
    // A page's headline, author and dates are often repeated on its WebPage node; one check covers both.
    const key = `${PAGE_LEVEL.has(property) ? "" : item}\u0000${property}\u0000${text}`;
    const where = { block, path };
    if (byKey.has(key)) return byKey.get(key).paths.push(where);
    const claim = { id: "", item, property, value: text, paths: [where] };
    if (raw !== undefined && raw !== text) claim.raw = raw;
    byKey.set(key, claim);
    claims.push(claim);
  };

  const visited = new Set();
  const visit = (value, ctx, block, path) => {
    if (Array.isArray(value)) return value.forEach((entry, i) => visit(entry, ctx, block, join(path, i)));
    if (!isObject(value) || visited.has(value)) return;
    const target = resolve(value);
    if (target !== value) {
      // A reference: follow it only to a part (an offer or a rating, say), which takes its item from here.
      const definition = definitions.get(value["@id"]);
      if (definition && typeNames(target).some((type) => PART_TYPES.has(type))) visit(target, ctx, definition.block, definition.path);
      return;
    }
    visited.add(value);
    const node = value;
    const types = typeNames(node);
    const isPart = types.some((type) => PART_TYPES.has(type));
    const isReview = types.includes("Review");
    // The item a claim is about: this node if it is one, else what it reviews, else the item around it.
    const reviewed = resolve(asArray(node.itemReviewed)[0]);
    const reviewedName = isObject(reviewed) ? describe(reviewed) : "";
    const item = (!isPart && describe(node)) || reviewedName || ctx.item || describe(node) || types[0] || "this page";
    // A part inherits the currency and reviewer of the node around it; a new item starts afresh.
    const here = {
      item,
      currency: textOf(node.priceCurrency) || (isPart ? ctx.currency : ""),
      reviewBy: isPart ? ctx.reviewBy : undefined,
    };
    const at = (key) => join(path, key);

    // Prices, with the currency of this node or of the offer around it.
    for (const [key, label] of [["price", "price"], ["lowPrice", "lowest price"], ["highPrice", "highest price"]]) {
      const amount = textOf(node[key]);
      if (!amount) continue;
      const priceType = textOf(node.priceType);
      const property = key === "price" && /(ListPrice|StrikethroughPrice)$/i.test(priceType) ? "list price" : label;
      add(item, property, here.currency ? `${amount} ${here.currency}` : amount, block, at(key));
    }
    const availability = textOf(node.availability);
    if (availability) add(item, "availability", availabilityInWords(availability), block, at("availability"), availability);

    // Ratings: the average for an item, or one reviewer's rating.
    const rating = textOf(node.ratingValue);
    if (rating) {
      const best = textOf(node.bestRating);
      const value = best ? `${rating} out of ${best}` : rating;
      const aggregate = types.includes("AggregateRating") || node.ratingCount !== undefined || node.reviewCount !== undefined;
      const property = ctx.reviewBy ? `rating in the review by ${ctx.reviewBy}` : aggregate ? "average rating" : "rating";
      add(item, property, value, block, at("ratingValue"));
    }
    if (textOf(node.ratingCount)) add(item, "number of ratings", textOf(node.ratingCount), block, at("ratingCount"));
    if (textOf(node.reviewCount)) add(item, "number of reviews", textOf(node.reviewCount), block, at("reviewCount"));

    const headline = textOf(node.headline);
    if (headline) add(types[0] ?? item, "headline", headline, block, at("headline"));

    // Authors of the item, or of a review of it. Authors and dates of other parts (answers, offers) are skipped.
    const authors = !isPart || isReview ? asArray(node.author).map(nameOf).filter(Boolean) : [];
    authors.forEach((name) => add(item, isReview ? "review author" : "author", name, block, at("author")));
    if (isReview && authors.length) here.reviewBy = authors[0];

    if (!isPart) {
      for (const [key, label, withTime] of DATES) {
        const raw = textOf(node[key]);
        if (raw) add(item, label, dateInWords(raw, withTime), block, at(key), raw);
      }
    }

    // A FAQ or Q&A question and its accepted answers.
    const answers = asArray(node.acceptedAnswer).map(resolve);
    if (types.includes("Question") && answers.some(isObject)) {
      const key = typeof node.name === "string" ? "name" : "text";
      const question = cap(typeof node[key] === "string" ? fragmentText(node[key]) : "", MAX_VALUE_CHARS);
      add(item, "question", question, block, at(key));
      const label = question ? `answer to "${cap(question, MAX_NAME_CHARS)}"` : "answer";
      answers.forEach((answer, i) => {
        if (!isObject(answer)) return;
        const text = typeof answer.text === "string" ? fragmentText(answer.text) : textOf(answer.text);
        const holder = Array.isArray(node.acceptedAnswer) ? join(at("acceptedAnswer"), i) : at("acceptedAnswer");
        add(item, label, text, block, join(holder, "text"));
      });
    }

    for (const address of asArray(node.address).map(resolve)) {
      const text =
        typeof address === "string"
          ? textOf(address)
          : isObject(address)
            ? ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"]
                .map((key) => (isObject(resolve(address[key])) ? nameOf(address[key]) : textOf(address[key])))
                .filter(Boolean)
                .join(", ")
            : "";
      if (text) add(item, "address", text, block, at("address"));
    }
    const contact = types.includes("ContactPoint") ? textOf(node.contactType) : "";
    for (const phone of asArray(node.telephone).map(textOf).filter(Boolean)) {
      add(item, contact ? `phone number (${contact})` : "phone number", phone, block, at("telephone"));
    }

    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("@") && key !== "@graph") continue;
      visit(child, here, block, join(path, key));
    }
  };

  // Items first, then parts that were only reachable through a reference nobody followed.
  const isReferencedPart = ({ node }) =>
    isObject(node) && referenced.has(node["@id"]) && typeNames(node).some((type) => PART_TYPES.has(type));
  for (const root of roots) if (!isReferencedPart(root)) visit(root.node, {}, root.block, root.path);
  for (const root of roots) visit(root.node, {}, root.block, root.path);

  claims.forEach((claim, i) => (claim.id = `c${i + 1}`));
  const types = [...new Set(roots.flatMap(({ node }) => (isObject(node) ? typeNames(node) : [])))];
  return { claims, types };
}

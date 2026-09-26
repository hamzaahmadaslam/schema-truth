import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import test from "node:test";
import { availabilityInWords, dateInWords, extractClaims } from "../src/claims.mjs";

// Any attempt to reach the network fails loudly: TypeSafe through fetch, a page through DNS, http or https.
const offline = () => {
  throw new Error("Tests must not use the network.");
};
globalThis.fetch = offline;
dns.lookup = dns.promises.lookup = offline;
http.request = http.get = https.request = https.get = offline;

/** Parsed blocks as readJsonLd returns them. */
const blocks = (...data) => data.map((entry, i) => ({ index: i + 1, line: 1, data: entry }));
/** Claims as [item, property, value] triples, which is what most tests compare. */
const triples = (result) => result.claims.map((claim) => [claim.item, claim.property, claim.value]);

test("Product: price with currency, availability in words, the average rating and counts, each review", () => {
  const result = extractClaims(
    blocks({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Trail Runner 2",
      offers: [
        { "@type": "Offer", price: 129, priceCurrency: "USD", availability: "https://schema.org/InStock" },
        {
          "@type": "Offer",
          priceCurrency: "EUR",
          priceSpecification: { "@type": "UnitPriceSpecification", price: "139.00", priceType: "https://schema.org/StrikethroughPrice" },
        },
        { "@type": "AggregateOffer", lowPrice: "99", highPrice: "149", priceCurrency: "USD", availability: "PreOrder" },
      ],
      aggregateRating: { "@type": "AggregateRating", ratingValue: 4.6, bestRating: 5, ratingCount: 312, reviewCount: "57" },
      review: [
        { "@type": "Review", author: { "@type": "Person", name: "Dana K." }, reviewRating: { "@type": "Rating", ratingValue: "5" } },
        { "@type": "Review", author: "Sam P.", reviewRating: { "@type": "Rating", ratingValue: 2, bestRating: 5 } },
      ],
    }),
  );
  const item = "Trail Runner 2 (Product)";
  assert.deepEqual(triples(result), [
    [item, "price", "129 USD"],
    [item, "availability", "in stock"],
    [item, "list price", "139.00 EUR"],
    [item, "lowest price", "99 USD"],
    [item, "highest price", "149 USD"],
    [item, "availability", "pre order"],
    [item, "average rating", "4.6 out of 5"],
    [item, "number of ratings", "312"],
    [item, "number of reviews", "57"],
    [item, "review author", "Dana K."],
    [item, "rating in the review by Dana K.", "5"],
    [item, "review author", "Sam P."],
    [item, "rating in the review by Sam P.", "2 out of 5"],
  ]);
  assert.deepEqual(result.types, ["Product"]);
  assert.deepEqual(
    result.claims.map((claim) => claim.id),
    result.claims.map((_, i) => `c${i + 1}`),
  );
  assert.deepEqual(result.claims[1], {
    id: "c2",
    item,
    property: "availability",
    value: "in stock",
    raw: "https://schema.org/InStock",
    paths: [{ block: 1, path: "offers[0].availability" }],
  });
  assert.deepEqual(result.claims[2].paths, [{ block: 1, path: "offers[1].priceSpecification.price" }]);
  assert.equal(availabilityInWords("http://schema.org/OutOfStock"), "out of stock");
});

test("@graph: authors and parts followed through @id, dates in words, page-level repeats checked once", () => {
  const result = extractClaims(
    blocks({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebPage",
          "@id": "https://site.example/guide#page",
          name: "Guide | Site",
          datePublished: "2026-03-02T08:00:00+00:00",
        },
        { "@type": "Offer", "@id": "#offer", price: "20", priceCurrency: "GBP" },
        {
          "@type": ["BlogPosting", "Thing"],
          headline: "Drying &amp; storing shoes",
          author: [{ "@id": "#rosa" }, { "@type": "Organization", name: "Site Team" }],
          datePublished: "2026-03-02T08:00:00+00:00",
          dateModified: "2026-08-19",
          offers: { "@id": "#offer" },
        },
        { "@type": "Person", "@id": "#rosa", name: "Rosa Lind" },
        { "@type": "Event", name: "Trail day", startDate: "2026-11-14T19:30:00-05:00", endDate: "not a date" },
      ],
    }),
  );
  const post = "Drying & storing shoes (BlogPosting)";
  assert.deepEqual(triples(result), [
    ["Guide | Site (WebPage)", "date published", "2 March 2026"],
    ["BlogPosting", "headline", "Drying & storing shoes"],
    [post, "author", "Rosa Lind"],
    [post, "author", "Site Team"],
    [post, "date modified", "19 August 2026"],
    [post, "price", "20 GBP"],
    ["Trail day (Event)", "start date", "14 November 2026, 19:30"],
    ["Trail day (Event)", "end date", "not a date"],
  ]);
  assert.deepEqual(result.claims[0].paths, [
    { block: 1, path: "@graph[0].datePublished" },
    { block: 1, path: "@graph[2].datePublished" },
  ]);
  assert.deepEqual(result.claims[5].paths, [{ block: 1, path: "@graph[1].price" }]);
  assert.deepEqual(result.types, ["WebPage", "Offer", "BlogPosting", "Thing", "Person", "Event"]);
  assert.equal(dateInWords("2026-13-01"), "2026-13-01");
});

test("FAQPage: each question and its answer, with HTML in answers reduced to text", () => {
  const result = extractClaims(
    blocks({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "Can I return worn shoes?",
          acceptedAnswer: { "@type": "Answer", text: "<p>Yes, within <strong>60</strong> days.</p>" },
        },
        { "@type": "Question", name: "Question without an answer" },
        { "@type": "Question", text: "Do you ship abroad?", acceptedAnswer: [{ "@type": "Answer", text: "To 12 countries." }] },
      ],
    }),
  );
  assert.deepEqual(triples(result), [
    ["FAQPage", "question", "Can I return worn shoes?"],
    ["FAQPage", 'answer to "Can I return worn shoes?"', "Yes, within 60 days."],
    ["FAQPage", "question", "Do you ship abroad?"],
    ["FAQPage", 'answer to "Do you ship abroad?"', "To 12 countries."],
  ]);
  assert.deepEqual(
    result.claims.map((claim) => claim.paths[0].path),
    ["mainEntity[0].name", "mainEntity[0].acceptedAnswer.text", "mainEntity[2].text", "mainEntity[2].acceptedAnswer[0].text"],
  );
});

test("addresses and phones, a rating that names its item, empty values and invalid blocks skipped", () => {
  const result = extractClaims([
    {
      index: 1,
      line: 3,
      data: {
        "@type": "LocalBusiness",
        name: "Harbour Bikes",
        telephone: ["+1 415 555 0142", " "],
        address: {
          "@type": "PostalAddress",
          streetAddress: "14 Quarry Lane",
          addressLocality: "Sampleton",
          postalCode: "",
          addressCountry: { "@type": "Country", name: "US" },
        },
        contactPoint: { "@type": "ContactPoint", telephone: "+1 415 555 0100", contactType: "customer service" },
        headline: "",
      },
    },
    { index: 2, line: 20, error: "invalid" },
    { index: 3, line: 25, data: { aggregateRating: { "@type": "AggregateRating", itemReviewed: { "@type": "Product", name: "Tree Shoe" }, ratingValue: "4.2" } } },
    { index: 4, line: 30, data: [{ "@type": "AggregateRating", ratingValue: "3.9", ratingCount: "12" }] },
  ]);
  assert.deepEqual(triples(result), [
    ["Harbour Bikes (LocalBusiness)", "address", "14 Quarry Lane, Sampleton, US"],
    ["Harbour Bikes (LocalBusiness)", "phone number", "+1 415 555 0142"],
    ["Harbour Bikes (LocalBusiness)", "phone number (customer service)", "+1 415 555 0100"],
    ["Tree Shoe (Product)", "average rating", "4.2"],
    ["AggregateRating", "average rating", "3.9"],
    ["AggregateRating", "number of ratings", "12"],
  ]);
  assert.deepEqual(result.claims[3].paths, [{ block: 3, path: "aggregateRating.ratingValue" }]);
  assert.deepEqual(result.claims[4].paths, [{ block: 4, path: "[0].ratingValue" }]);
  assert.deepEqual(extractClaims([]), { claims: [], types: [] });
});

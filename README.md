# schema-truth

Checks whether the values in a page's JSON-LD (prices, availability, ratings, reviews, authors, dates, headlines, FAQ
answers, addresses and phone numbers) are shown in the text visitors see; for SEO specialists and developers who
look after structured data.

Google's [structured data policies](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)
rule out marking up content that readers of the page cannot see, and ask that markup be "a true representation of
the page content". Markup drifts from the page: a sale changes the price on the page but not in the JSON-LD, a
plugin keeps last year's FAQ answer, a rating count comes from another system. Schema validators check that the
markup is well formed and has the required properties; they do not compare its values with the page. A string match
cannot tell that "2 March 2026" on the page is the `2026-03-02` in the markup, or that "$109.00" is not the
`129.00 USD` it claims. A text-generating model can judge that, but it returns prose to parse and no measure of how
sure it is. schema-truth asks one yes/no question per value and gets a probability back, so code makes the call and
unclear values go to a review list.

## How it uses Jev

Jev is TypeSafe AI's System One model: it answers typed questions with probabilities and writes no text.

Code does the reading. For each page, schema-truth extracts every `<script type="application/ld+json">` block,
follows `@graph` and `@id` links, and turns the values worth checking into claims:

| Markup                                            | Claims                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Offer`, `AggregateOffer`, `PriceSpecification`   | price with its currency, lowest and highest price, list price, availability          |
| `AggregateRating`, `Review`                       | average rating, number of ratings, number of reviews, each review's author and rating |
| `Article`, `BlogPosting`, `Event` and other items | headline, author, date published, date modified, start date, end date                |
| `FAQPage`, `QAPage`                               | each question, and its accepted answer                                               |
| `Organization`, `LocalBusiness`, `ContactPoint`   | address, phone number                                                                |

It also extracts the text a visitor sees. Left out: scripts, styles, the `<head>`, `<noscript>`, `<template>`, inline
SVG, closed `<dialog>` elements, and anything inside an element with the `hidden` attribute or an inline
`display: none` or `visibility: hidden` style. Image alt text is kept as `[image: ...]`, and table cells are joined
with `|`.

Then it sends one request per page. The visible text is the state, and each claim is one noul (a yes/no question),
with the claim passed as data next to a fixed question:

```json
{
  "state": { "visible_text": "Northfield Outfitters Shoes Delivery\nTrail Runner 2\nWas $129.00, now $109.00 until Sunday\n..." },
  "questions": {
    "c1": {
      "type": "noul",
      "instructions": {
        "claim": { "item": "Trail Runner 2 (Product)", "property": "price", "value": "129.00 USD" },
        "question": "Is the value in `claim` supported by `visible_text`, the text a visitor sees on the page?"
      },
      "criteria": {
        "true": "`visible_text` shows this value for this property of this item. It may be written another way: ...",
        "false": "`visible_text` does not show this value, shows a different value for this property, or ..."
      }
    }
  }
}
```

Before a value is sent, code rewrites ISO dates in words ("2 March 2026") and availability URLs as words ("in
stock"), the way pages show them. TypeSafe's notes on jev-1.13 advise doing such conversions in code rather than
leaving them to the model. The full wording is in `src/check.mjs`, and `--dry-run --json` prints every request
body.

The verdict is made in code with one threshold, `--threshold` (default 0.8):

| Verdict     | When                                                                               |
| ----------- | ---------------------------------------------------------------------------------- |
| supported   | the probability is at least the threshold                                          |
| unsupported | the probability is at most 1 minus the threshold (0.2 by default)                  |
| review      | anything in between, a missing answer, or a page with no visible text in its HTML |

A page whose visible text is longer than about 16,000 tokens is sent in parts, each with every claim, and a claim
counts as supported when any part shows it. The report prints the probability next to every claim. Every word in it
comes from your pages or from fixed text in the code.

## Install

Needs Node.js 20 or later. It has no dependencies.

```sh
npm install -g github:hamzaahmadaslam/schema-truth
```

## Usage

```sh
export TYPESAFE_API_KEY=<your-key>
schema-truth https://shop.example/trail-runner-2
```

In PowerShell, set the key with `$env:TYPESAFE_API_KEY = "<your-key>"`.

```sh
schema-truth https://shop.example/a https://shop.example/b   # several pages in one run
schema-truth saved-pages/                                     # every .html, .htm and .xhtml file below a folder
schema-truth page.html --dry-run                              # the claims, the question and a token estimate; nothing sent to TypeSafe
schema-truth https://shop.example/a --json > report.json
schema-truth saved-pages/ --threshold 0.9                     # stricter: more claims go to review
```

| Option                | Default | What it does                                                                                     |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `--threshold <p>`     | `0.8`   | Probability needed to call a claim supported or unsupported. Above 0.5, at most 1.               |
| `--timeout <seconds>` | `10`    | Time limit for each page and each TypeSafe request. Rate limits (429) and overload (529) are retried three times. |
| `--json`              | off     | Print JSON: every page, every claim, its verdict and the raw probability.                        |
| `--dry-run`           | off     | Read the pages and print the claims and a token estimate. Needs no key; sends nothing to TypeSafe. |

Environment: `TYPESAFE_API_KEY` (not needed for `--dry-run`, or when no page has claims to check) and
`TYPESAFE_MODEL` (default `jev-latest`).

Exit codes: `0` when no claim is unsupported, `1` when at least one is, so it can fail a CI job, and `2` on an error
or when a page could not be read. Claims in review do not change the exit code. JSON-LD blocks that are not valid
JSON are listed in the report but do not change it either.

### Fetching pages

- Only `http` and `https` URLs.
- Before connecting, schema-truth resolves the host name and checks every address it gets back. Loopback, private,
  link-local, cloud metadata (such as `169.254.169.254` and `fd00:ec2::254`), multicast and other reserved ranges,
  IPv4 and IPv6, are refused, including addresses written into the URL itself. The connection then goes only to the
  addresses that passed, so a second DNS answer cannot point it somewhere else. The same checks run again on every
  redirect, and it follows at most 3.
- A 10 second limit per page (`--timeout`), and at most 2 MB of HTML. Compressed pages (gzip, deflate, br) are
  decompressed and the limit applies to the result.
- The User-Agent is `schema-truth/1.0.0 (+https://github.com/hamzaahmadaslam/schema-truth)`.
- To check a page on your own machine or network, or one the site does not serve to tools, save it from your browser
  and pass the file.

## Example

`examples/pages` holds three short pages for a made-up shop, written for this example: a product page, a delivery
FAQ and an article. The probabilities below come from `examples/fixture-answers.json`: they were written by hand for
the tests, not recorded from TypeSafe, and show the report format. Your numbers will differ.
`node examples/run.mjs` prints this report without a key or a network call.

```text
schema-truth: 20 claims on 3 pages
Model jev-1.13.0, 3 requests, 3,420 input tokens (under $0.001), threshold 0.8

supported 12   unsupported 6   review 2

delivery-faq.html
  1 JSON-LD block (FAQPage); 6 claims: unsupported 1, review 1, supported 4
  unsupported  0.04  answer to "Can I return shoes I have worn?": Yes, within 60 days of delivery.
                     FAQPage; block 1, mainEntity[1].acceptedAnswer.text
  review       0.46  answer to "Do you ship to Canada?": Yes, we ship to every province.
                     FAQPage; block 1, mainEntity[2].acceptedAnswer.text
  supported    0.98  question: How long does delivery take?
  supported    0.95  answer to "How long does delivery take?": Orders arrive in 2 to 4 working days.
  supported    0.97  question: Can I return shoes I have worn?
  supported    0.94  question: Do you ship to Canada?

shoe-care-guide.html
  2 JSON-LD blocks (BlogPosting, Person, Organization), 1 not valid JSON; 6 claims: unsupported 2, supported 4
  block 2 (line 41) is not valid JSON; its claims were not checked
  unsupported  0.06  date modified: 19 August 2026
                     How to dry wet trail shoes (BlogPosting); block 1, @graph[0].dateModified
  unsupported  0.03  phone number: +1-415-555-0142
                     Northfield Outfitters (Organization); block 1, @graph[2].telephone
  supported    0.98  headline: How to dry wet trail shoes
  supported    0.96  author: Rosa Lind
  supported    0.93  date published: 2 March 2026
  supported    0.87  address: 14 Quarry Lane, Sampleton, 00014, US

trail-runner.html
  1 JSON-LD block (Product); 8 claims: unsupported 3, review 1, supported 4
  unsupported  0.08  number of ratings: 312
                     Trail Runner 2 (Product); block 1, aggregateRating.ratingCount
  unsupported  0.05  review author: Sam P.
                     Trail Runner 2 (Product); block 1, review[1].author
  unsupported  0.04  rating in the review by Sam P.: 2 out of 5
                     Trail Runner 2 (Product); block 1, review[1].reviewRating.ratingValue
  review       0.41  price: 129.00 USD
                     Trail Runner 2 (Product); block 1, offers.price
  supported    0.95  availability: in stock
  supported    0.97  average rating: 4.6 out of 5
  supported    0.96  review author: Dana K.
  supported    0.93  rating in the review by Dana K.: 5 out of 5

supported: the visible text shows the value (probability at or above 0.8).
unsupported: the visible text does not show it (probability at or below 0.2). Google asks that structured
  data describe only content visible to readers of the page:
  https://developers.google.com/search/docs/appearance/structured-data/sd-policies
review: Jev was not sure either way, or had no text to read. Check these on the page yourself.
```

The FAQ markup promises returns within 60 days while the page says 30 days and unworn shoes only. The article's
markup has a modified date the page never shows and a phone number that differs from the one in the footer, and its
breadcrumb block has a trailing comma. The product markup counts 312 ratings where the page shows 48 reviews, and it
lists a review by Sam P. that sits in a `hidden` element. The price sits in the middle: `129.00` is on the page, but
struck through next to the $109.00 sale price, so it goes to review. The same run with `--json` is in
`examples/report.json`, and the dry run in `examples/dry-run.txt`.

## What leaves your machine

Two kinds of requests, and no others:

- To each URL you pass, and to the redirects it sends (at most 3): a `GET` request with the User-Agent above and
  standard `Accept` headers. No cookies. Saved files are read from disk and nothing is fetched for them.
- To `https://api.typesafe.ai/v1/systemone`, only when you run it with a key and without `--dry-run`: the visible
  text of each page as extracted (at most about 16,000 tokens of it per request), each claim (the item's name, the
  property and the value), the fixed question text, question ids such as `c1`, and the model name. Your API key goes
  in the `Authorization` header.

TypeSafe does not receive a page's URL or file name, its raw HTML, the JSON-LD blocks themselves or the paths inside
them. The tool writes nothing to disk and makes no other network requests, for telemetry, updates or anything else.

## Limits

- It reads the HTML as served. Scripts do not run, so content a script adds is missed; save the rendered page from
  your browser if the site builds it that way. Stylesheets are not loaded either, so text hidden only by a CSS class
  (a closed accordion or tab, screen-reader-only text) counts as visible. Text inside `<details>` counts as visible.
- Only JSON-LD. Microdata and RDFa are not read.
- Only the claims in the table above are checked. Brand, SKU, opening hours, images and breadcrumb names are not.
- "unsupported" means the visible text does not show the value. How much that matters depends on the property: a
  price or review the page does not show is a bigger problem than a modified date.
- Jev reads numbers and dates as text, and the tool does no arithmetic, so a rating shown as a percentage or a price
  shown in another currency will usually go to review or come back unsupported.
- On a page checked in parts, a value whose context falls in another part may be judged wrongly.
- English is where Jev is most accurate. The token estimate assumes four characters per token, which fits English.
- Text written to steer a model, in the page or in the markup, can move Jev's answers.
- The tool reports and never edits anything. Read the review list yourself, and check a sample of verdicts on your
  own pages before you rely on a threshold.

## Cost

TypeSafe charges $0.042 per million input tokens for jev-1.13; output tokens are free. The visible text is most of
each request, and each claim adds about 160 tokens. By the tool's own estimate (four characters per token):

| Run                                                             | Requests | Input tokens   | Cost          |
| --------------------------------------------------------------- | -------- | -------------- | ------------- |
| The example: 20 claims on 3 short pages                         | 3        | about 3,400    | under $0.001  |
| A product page with about 9,300 tokens of text and 11 claims    | 1        | about 11,100   | under $0.001  |
| 1,000 pages like that one                                       | 1,000    | about 11.1 million | about $0.47 |

`--dry-run` prints the estimate for your own pages before you spend anything.

## License

MIT. Made by [Hamza Ahmad Aslam](https://hamzaahmadaslam.com), WordPress and web performance engineer.

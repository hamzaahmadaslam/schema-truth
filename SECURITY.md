# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue for a security problem.

You will get a reply within seven days. Fixes are released as a new version with a note in the changelog.

A way to make the tool connect to a loopback, private, link-local or cloud metadata address, or to read more than
the limits in the README allow, counts as a security problem. Please report it privately.

## What this project does with your data

- It reads your TypeSafe API key from the `TYPESAFE_API_KEY` environment variable and sends it only to
  `https://api.typesafe.ai` in the `Authorization` header. It never logs, prints or stores the key.
- It fetches only the URLs you pass on the command line, and the redirects they send (at most 3 each), after
  checking that every address the host name resolves to is public. Saved HTML files are read from disk.
- It sends only the text described in the README's "What leaves your machine" section to TypeSafe, and only when
  you run it with a key.
- It makes no other network requests: no telemetry, no update checks.

## Supported versions

Only the latest release receives fixes.

# Context Hypervisor Rules

The rule registry for the **Context Hypervisor** Chrome extension. The extension has no rules of its own:
it downloads them from here, and the user chooses which ones to install.

A rule is **data, never code**. It says which parts of a page to read, which read-only requests to make,
and what prompt to build. The extension's bundled engine does the work. (Chrome's Manifest V3 does not allow an
extension to download and run code, and running code from a public repo inside people's logged-in sessions would
be unsafe anyway.)

```
rules/<site>/<rule>.json    one file per rule; the path is the rule's id ("leetcode.com/complexity-brief")
schema/rule.schema.json     JSON Schema for a rule
engine/rule_engine.js       a copy of the extension's engine, used by CI (see "Keeping the engine in sync")
scripts/                    validate, build, serve, sync-engine
tests/                      tests for the rules and for the safety checks
site/index.html             the browse page published with the catalogue
docs/RULE_FORMAT.md         how to write a rule
```

## Publish it (one time)

1. Create an empty GitHub repository and push this folder to it (`main` branch).
2. In the repository: **Settings -> Pages -> Build and deployment -> Source: GitHub Actions**.
3. The *Publish rules* workflow runs on every push to `main`. When it finishes, your registry is at
   `https://<your-user>.github.io/<repo>/index.json` and the browse page is at `https://<your-user>.github.io/<repo>/`.
4. Tell the extension where it is: open the extension's **Rule Library -> Registry source** and paste the
   `index.json` address (or set `DEFAULT_REGISTRY_URL` at the top of the extension's `registry.js` before you ship it).

## Try it locally first

```
npm install
npm run check      # validate + tests + build
npm run serve      # serves dist/ at http://localhost:8080/index.json
```

Paste `http://localhost:8080/index.json` into the extension's Rule Library -> Registry source.

## Adding or changing a rule

1. Add `rules/<site>/<slug>.json` (see `docs/RULE_FORMAT.md`). The file path must match the rule's `id`.
2. **Bump `version` whenever you change a rule.** The extension offers an update when the catalogue's version is
   higher than the installed one, and never applies it silently.
3. `npm run check`. Every pull request runs the same checks.

## What CI enforces

* the JSON Schema (no unknown fields at any level);
* the engine's validator: read-only GraphQL only (no mutations or subscriptions), requests only to the page's own
  site, regexes that cannot hang the tab, no variable cycles, templates that only use declared variables;
* the LeetCode rules' tests, which run each rule against a stand-in for the real site;
* every file in the catalogue has a sha256, which the extension verifies before installing.

The extension checks all of this again when it installs a rule, so a rule that slips past CI (or a registry that is
compromised) still cannot make the extension send a mutation or run a dangerous pattern.

## Keeping the engine in sync

The engine lives in the extension (`rule_engine.js`). This repo keeps a copy in `engine/` so CI can validate rules.
After changing the engine in the extension, run `npm run sync-engine` here (set `EXTENSION_DIR` if the extension is
not in `../ChrExt`), and `npm run sync-engine -- --check` to see whether the copy is stale.
A rule that needs a newer engine sets `minEngine`; older extensions then show it as "needs a newer version".

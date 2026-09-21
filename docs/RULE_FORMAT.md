# Rule format

A rule is one JSON file. `text` may be a string or an array of lines (joined with newlines when published).

```json
{
  "schemaVersion": 1,
  "id": "leetcode.com/complexity-brief",
  "version": 1,
  "minEngine": 1,
  "name": "Complexity & Optimality Check",
  "description": "What the rule does, in a sentence or two.",
  "author": "Your name",
  "domains": ["leetcode.com"],
  "tags": ["leetcode", "complexity"],
  "match": { "pathRegex": "^/submissions/detail/\\d+", "hint": "Open one of your submissions to use this rule." },
  "inputs": [],
  "requests": {},
  "variables": {},
  "text": ["Problem: {{problem_header}}", "", "{{code_block}}"]
}
```

| Field | Notes |
|---|---|
| `id` | `<site>/<slug>`; must equal the file path. Use `general/<slug>` for rules that apply everywhere. |
| `version` | Integer. **Bump it on every change**; that is how users get updates. |
| `minEngine` | Lowest engine version that can run the rule. |
| `domains` | Sites where the rule is offered. A host matches its subdomains. `"*"` means every site. |
| `match.pathRegex` | Optional. If the page path does not match, the user is shown `hint` and nothing is read or sent. |
| `text` | The prompt. `{{name}}` placeholders use **visible** variables, or the built-ins `CONTENT`, `URL`, `TITLE`, `DOMAIN`, `GLOBAL_CONTEXT`, `HISTORY`. |

## Variables

`variables` maps a name to `{ sources, transform?, map?, maxChars?, hidden? }`.

* `sources` are tried in order; the first non-empty result wins.
* `hidden: true` marks a helper: other variables can use it, but it is never sent and never reported.
* Variables resolve **on demand**, so declaration order does not matter (Chrome storage does not preserve it).
* Every variable is capped (20,000 characters by default, 50,000 at most), whatever `maxChars` says.

| Source | Fields | Result |
|---|---|---|
| `url` | `regex` | capture group 1 of the regex run over the page address |
| `css` | `selector`, `attr?`, `regex?` | text (or attribute) of the matching elements |
| `graphql` | `request`, `path` | the value at `path` in a request's JSON response |
| `var` | `name`, `regex?` | another variable |
| `format` | `template` | `{{a}} {{b}}`; empty if any variable it uses is empty |
| `input` | `name`, `regex?` | a value typed into the rule's form (see `inputs`) |
| `literal` | `value` | a fixed string |

Transforms: `htmlToText`, `round2`, `slugToTitle`, `trim`, `stripLineNumbers`. `map` turns a value into another
string (for example a status code into a word).

Give the important variables **fallbacks**: list a second source (for example a page element) after the API one, so
the rule still works when the API changes.

## Requests

```json
"requests": {
  "question": {
    "endpoint": "/graphql",
    "query": "query q($slug: String!) { question(titleSlug: $slug) { title content } }",
    "variables": { "slug": "{{title_slug}}" },
    "numericVars": []
  }
}
```

* Requests are `POST`ed as JSON to the page's own site (`endpoint` is a path such as `/graphql`), with the user's cookies.
* Only **read-only queries** are allowed. Mutations and subscriptions are rejected by CI and by the extension.
* `query` may be a list of alternatives; they are tried in order.
* Variables may use `{{other_variable}}`; the engine resolves what a request needs first.

## Inputs (a form instead of, or as well as, reading the page)

```json
"inputs": [
  { "key": "code", "label": "Your code", "type": "textarea", "rows": 9, "required": true },
  { "key": "style", "label": "Answer style", "type": "select", "default": "brief",
    "options": [{ "value": "brief", "label": "Brief" }, { "value": "detailed", "label": "With explanation" }] }
]
```

Types: `text`, `textarea`, `select`. Read them with `{ "from": "input", "name": "code" }`. The user can also fill a
text field from the page with the extension's "Pick from page" button.

## Testing a rule

Add a test in `tests/` that runs `engine.extract(rule, env)` against a fake page and a fake API response
(see `tests/leetcode.test.js`). Rules for sites that need a login cannot be tested against the real site in CI, so
keep the fixtures realistic and update them when the site changes.

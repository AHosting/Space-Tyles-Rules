// The rule engine lives in the extension. This repo keeps a copy so CI can validate rules and run their tests.
//   npm run sync-engine            copy ../ChrExt/rule_engine.js into engine/
//   npm run sync-engine -- --check report whether the copy is out of date (exit 1 if so)
const fs = require("fs");
const path = require("path");

const SOURCE = process.env.EXTENSION_DIR ? path.join(process.env.EXTENSION_DIR, "rule_engine.js") : path.resolve(__dirname, "../../ChrExt/rule_engine.js");
const COPY = path.resolve(__dirname, "../engine/rule_engine.js");

if (!fs.existsSync(SOURCE)) {
  console.log(`Extension not found at ${SOURCE}. Set EXTENSION_DIR to its folder.`);
  process.exit(process.argv.includes("--check") ? 0 : 1);
}
const same = fs.readFileSync(SOURCE, "utf8") === fs.readFileSync(COPY, "utf8");
if (process.argv.includes("--check")) {
  console.log(same ? "✓ engine copy is up to date" : "✗ engine/rule_engine.js differs from the extension's — run: npm run sync-engine");
  process.exit(same ? 0 : 1);
}
fs.copyFileSync(SOURCE, COPY);
console.log(same ? "engine copy was already up to date" : "✓ copied the extension's rule_engine.js into engine/");

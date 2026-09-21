// Shared helpers for the registry scripts.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const engine = require("../engine/rule_engine.js");

const ROOT = path.resolve(__dirname, "..");
const RULES_DIR = path.join(ROOT, "rules");

function listRuleFiles(dir = RULES_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? listRuleFiles(path.join(dir, e.name)) : (e.name.endsWith(".json") ? [path.join(dir, e.name)] : []))
    .sort();
}

// "rules/leetcode.com/complexity-brief.json" -> "leetcode.com/complexity-brief"
const expectedId = (file) => path.relative(RULES_DIR, file).replace(/\.json$/, "").split(path.sep).join("/");

function readRule(file) {
  const raw = fs.readFileSync(file, "utf8");
  try {
    return { file, raw, rule: JSON.parse(raw) };
  } catch (e) {
    return { file, raw, error: `not valid JSON: ${e.message}` };
  }
}

// The exact text that gets published for a rule. The catalogue's sha256 is computed over these bytes.
const publishedText = (rule) => JSON.stringify(engine.normalizeRule(rule), null, 2) + "\n";
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

module.exports = { ROOT, RULES_DIR, engine, listRuleFiles, expectedId, readRule, publishedText, sha256 };

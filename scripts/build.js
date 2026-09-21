// Builds dist/: the normalised rule files, the catalogue (index.json) with a sha256 for each file, and the browse site.
// The extension downloads index.json, then verifies every rule file it fetches against the hash listed here.
const fs = require("fs");
const path = require("path");
const { ROOT, RULES_DIR, listRuleFiles, readRule, publishedText, sha256 } = require("./lib");

const DIST = path.join(ROOT, "dist");

function build() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const entries = listRuleFiles().map(file => {
    const { rule, error } = readRule(file);
    if (error) throw new Error(`${file}: ${error}`);
    const rel = path.relative(RULES_DIR, file).split(path.sep).join("/");
    const outPath = path.join(DIST, "rules", rel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const text = publishedText(rule);
    fs.writeFileSync(outPath, text);
    return {
      id: rule.id,
      name: rule.name,
      description: rule.description,
      version: rule.version,
      minEngine: rule.minEngine,
      domains: rule.domains,
      tags: rule.tags || [],
      author: rule.author || "",
      path: `rules/${rel}`,
      sha256: sha256(Buffer.from(text))
    };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const index = { schemaVersion: 1, generatedAt: new Date().toISOString(), rules: entries };
  fs.writeFileSync(path.join(DIST, "index.json"), JSON.stringify(index, null, 2) + "\n");

  const siteDir = path.join(ROOT, "site");
  if (fs.existsSync(siteDir)) fs.cpSync(siteDir, DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, ".nojekyll"), "");
  return index;
}

if (require.main === module) {
  const index = build();
  console.log(`✓ built dist/ with ${index.rules.length} rule(s)`);
}
module.exports = { build, DIST };

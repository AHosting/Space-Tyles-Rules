// Validates every rule: JSON Schema, the engine's own validator (safety rules), and registry conventions.
// The extension runs the same engine validator again before it installs anything.
const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const { ROOT, engine, drivers, listRuleFiles, listDriverFiles, expectedId, expectedDriverId, readRule } = require("./lib");

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "rule.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

const driverSchemaPath = path.join(ROOT, "schema", "driver.schema.json");
const validateDriverSchema = fs.existsSync(driverSchemaPath)
  ? ajv.compile(JSON.parse(fs.readFileSync(driverSchemaPath, "utf8")))
  : null;

function validateFile(file, seenIds) {
  const problems = [];
  const rel = path.relative(ROOT, file);
  const { rule, error } = readRule(file);
  if (error) return [`${rel}: ${error}`];

  if (!validateSchema(rule)) {
    validateSchema.errors.forEach(e => problems.push(`${rel}: schema: ${e.instancePath || "(root)"} ${e.message}`));
  }
  engine.validateRule(rule).forEach(m => problems.push(`${rel}: ${m}`));

  if (rule.id !== expectedId(file)) problems.push(`${rel}: id "${rule.id}" must match the file path ("${expectedId(file)}")`);
  if (seenIds.has(rule.id)) problems.push(`${rel}: duplicate id "${rule.id}"`);
  seenIds.add(rule.id);
  if (Array.isArray(rule.domains) && !rule.domains.includes("*") && !rule.id.startsWith("general/")) {
    const site = rule.id.split("/")[0];
    if (!rule.domains.some(d => d === site || d.endsWith("." + site) || site.endsWith("." + d))) {
      problems.push(`${rel}: the id's site folder "${site}" should be one of the rule's domains`);
    }
  }
  return problems;
}

// A driver gets the same treatment: JSON Schema, then the shared validator the extension itself runs before
// installing one, then the registry's own conventions about ids and paths.
function validateDriverFile(file, seenIds) {
  const problems = [];
  const rel = path.relative(ROOT, file);
  const { rule: driver, error } = readRule(file);
  if (error) return [rel + ": " + error];

  if (validateDriverSchema && !validateDriverSchema(driver)) {
    validateDriverSchema.errors.forEach(e => problems.push(rel + ": schema: " + (e.instancePath || "(root)") + " " + e.message));
  }
  drivers.validateDriver(driver).forEach(m => problems.push(rel + ": " + m));

  if (driver.id !== expectedDriverId(file)) problems.push(rel + ': id "' + driver.id + '" must match the file path ("' + expectedDriverId(file) + '")');
  if (seenIds.has(driver.id)) problems.push(rel + ': duplicate id "' + driver.id + '"');
  seenIds.add(driver.id);
  if (Array.isArray(driver.domains) && !driver.domains.includes("*")) {
    const site = String(driver.id).split("/")[0];
    if (!driver.domains.some(d => d === site || d.endsWith("." + site) || site.endsWith("." + d))) {
      problems.push(rel + ': the id\'s site folder "' + site + '" should be one of the driver\'s domains');
    }
  }
  return problems;
}

function main() {
  const files = listRuleFiles();
  const seen = new Set();
  const problems = files.flatMap(f => validateFile(f, seen));

  const driverFiles = listDriverFiles();
  const seenDrivers = new Set();
  problems.push(...driverFiles.flatMap(f => validateDriverFile(f, seenDrivers)));

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n` + problems.map(p => "  ✗ " + p).join("\n"));
    process.exit(1);
  }
  console.log(`✓ ${files.length} rule(s) and ${driverFiles.length} driver(s) valid`);
}

if (require.main === module) main();
module.exports = { validateFile, validateDriverFile };

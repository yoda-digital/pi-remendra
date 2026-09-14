#!/usr/bin/env node
// Check that benchmarks/suite.mjs exists and produces valid JSON with required fields.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const path = new URL("./suite.mjs", import.meta.url).pathname;
if (!existsSync(path)) {
  console.error("FAIL: benchmarks/suite.mjs does not exist");
  process.exit(1);
}
try {
  const output = execFileSync("node", [path], {
    timeout: 90_000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = JSON.parse(output.trim());
  const required = ["suite", "dimensions", "composite_score", "verdict"];
  for (const key of required) {
    if (!(key in result)) {
      console.error(`FAIL: missing required key '${key}' in benchmark output`);
      process.exit(1);
    }
  }
  const dims = result.dimensions;
  const speed = dims.compilation_speed_ms || dims.compilation_speed;
  if (!dims.context_density || !dims.retrieval_precision || !speed) {
    console.error("FAIL: missing dimension in benchmark output");
    console.error("Found keys:", Object.keys(dims).join(", "));
    process.exit(1);
  }
  console.log("PASS: benchmark suite produced valid output");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error("FAIL:", error.message);
  process.exit(1);
}

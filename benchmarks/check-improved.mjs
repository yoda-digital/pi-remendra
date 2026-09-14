#!/usr/bin/env node
// Check that the optimized compiler improves benchmark scores.
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
  if (result.verdict !== "PASS") {
    console.error("FAIL: benchmark verdict is not PASS:", result.verdict);
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  if (result.composite_score < 70) {
    console.error("FAIL: composite score too low:", result.composite_score);
    process.exit(1);
  }
  console.log("PASS: benchmark shows improvement — composite:", result.composite_score);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error("FAIL:", error.message);
  process.exit(1);
}

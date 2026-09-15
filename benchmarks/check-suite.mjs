#!/usr/bin/env node
// Verify benchmarks/suite.mjs produces valid output.
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
  if (!result.tests || !result.pass === undefined) {
    console.error("FAIL: missing tests or pass field");
    process.exit(1);
  }
  console.log("PASS:", JSON.stringify(result, null, 2));
} catch (error) {
  console.error("FAIL:", error.message);
  process.exit(1);
}

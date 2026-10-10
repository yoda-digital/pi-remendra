#!/usr/bin/env node

/**
 * Pre-commit hook — format and lint staged files only.
 * Mirrors pi-utils/scripts/pre-commit.mjs
 * 1. pnpm exec lint-staged  → oxfmt + eslint --fix on staged files
 * 2. Re-stage anything that was modified
 */

import { execFileSync } from "node:child_process";

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function stagedFiles() {
  const output = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    encoding: "utf8",
  });
  return output
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter(Boolean);
}

const before = stagedFiles();
run("pnpm", ["exec", "lint-staged"]);
const after = stagedFiles();
const modified = after.filter((f) => before.includes(f));
if (modified.length > 0) {
  // -u: these paths are all in the index already, and the committed dist/ build is
  // gitignored, so a plain `git add` refuses it.
  run("git", ["add", "-u", "--", ...modified]);
}

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./text.js";

/**
 * Diagnostics go to a log file, never the terminal: Pi does not capture console
 * output, so a stray stderr line draws over its interactive screen. The main
 * thread and the storage worker each set the file at startup; without one
 * (tests, the CLI) lines go to stderr.
 */
let file: string | undefined;
const MAX_BYTES = 1_000_000;

export function setLogFile(path: string | undefined): void {
  file = path;
  if (path)
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    } catch {
      /* the first write reports nothing either; logging never throws */
    }
}

export function logFile(): string | undefined {
  return file;
}

export function log(...parts: unknown[]): void {
  const text = parts
    .map((p) => (p instanceof Error ? p.message : typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ");
  const line = `${new Date().toISOString()} ${redact(text)}\n`;
  if (!file) {
    process.stderr.write(line);
    return;
  }
  try {
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
    } catch {
      /* no file yet */
    }
    appendFileSync(file, line, { mode: 0o600 });
  } catch {
    /* logging must never break memory */
  }
}

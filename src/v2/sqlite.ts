import { createRequire } from "node:module";

export type SqlValue = string | number | null | Uint8Array;
export interface Statement {
  run(...args: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...args: SqlValue[]): Record<string, unknown> | undefined;
  all(...args: SqlValue[]): Record<string, unknown>[];
}
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

const require = createRequire(import.meta.url);
export function openDatabase(file: string): Database {
  if ("Bun" in globalThis) {
    const sqlite = require("bun:sqlite") as { Database: new (path: string) => Database };
    return new sqlite.Database(file);
  }
  const sqlite = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { timeout: number }) => Database;
  };
  return new sqlite.DatabaseSync(file, { timeout: 3000 });
}

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
  // Bun has its own SQLite
  if ("Bun" in globalThis) {
    const sqlite = require("bun:sqlite") as { Database: new (path: string) => Database };
    return new sqlite.Database(file);
  }

  // Node 24+: use built-in node:sqlite (zero dependencies)
  try {
    const sqlite = require("node:sqlite") as {
      DatabaseSync: new (path: string, options?: { timeout: number }) => Database;
    };
    return new sqlite.DatabaseSync(file, { timeout: 3000 });
  } catch {
    // Node 22: fall back to better-sqlite3 (optional peer dependency)
  }

  try {
    const BetterSqlite3 = require("better-sqlite3") as new (
      path: string,
      options?: { timeout: number },
    ) => Database;
    return new BetterSqlite3(file, { timeout: 3000 });
  } catch {
    throw new Error(
      "Remendra requires SQLite. On Node 24+ it works out of the box. " +
        "On Node 22, install better-sqlite3: pnpm add better-sqlite3",
    );
  }
}

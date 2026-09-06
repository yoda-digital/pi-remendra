#!/usr/bin/env node
import { realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryService } from "./service.js";
import { sourceInputs } from "./sources.js";
import { jsonObject } from "./text.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Scope } from "./types.js";

export function main(argv: string[]): void {
  const args = [...argv];
  const take = (flag: string, fallback?: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    args.splice(index, 2);
    return value;
  };
  const directory = resolve(
    take(
      "--home",
      process.env.PI_REMENDRA_HOME ?? join(homedir(), ".pi", "agent", "pi-remendra", "v2"),
    )!,
  );
  const cwd = realpathSync(take("--project", process.cwd())!);
  const sessionFile = take("--session");
  const service = new MemoryService(join(directory, "memory.sqlite"), directory);
  try {
    let entries: SessionEntry[] = [];
    let sessionId = "cli";
    if (sessionFile) {
      const rows = readFileSync(sessionFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
      const header = rows.find((row) => jsonObject(row) && row.type === "session");
      if (jsonObject(header) && typeof header.id === "string") sessionId = header.id;
      const all = rows.filter(
        (row): row is SessionEntry =>
          jsonObject(row) && typeof row.id === "string" && row.type !== "session",
      ) as SessionEntry[];
      const byId = new Map(all.map((e) => [e.id, e]));
      let current = all.at(-1);
      const visited = new Set<string>();
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        entries.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
    }
    const scope: Scope = {
      projectId: service.project(cwd),
      sessionId,
      entryIds: entries.map((e) => e.id),
      includeUser: service.config.includeUser,
      environment: process.env.PI_REMENDRA_ENVIRONMENT,
    };
    const [command = "status", ...rest] = args;
    let result: unknown;
    if (command === "sync")
      result = service.ingest(scope, sourceInputs(entries, service.config.excludedPaths));
    else if (command === "status") result = { scope, ...service.status(scope) };
    else if (command === "doctor") result = service.doctor();
    else if (command === "search") result = service.recall(scope, { query: rest.join(" ") });
    else if (command === "why") result = service.explain(scope, rest[0]);
    else if (command === "gaps") result = service.gaps(scope);
    else if (command === "checkpoint")
      result = service.checkpoint(scope, rest.join(" "), service.config.summaryTokens);
    else if (command === "export")
      result = service.export(scope, rest[0] ? resolve(rest[0]) : undefined);
    else if (command === "backup") {
      if (!rest[0]) throw new Error("backup requires a new destination file");
      result = service.backup(resolve(rest[0]));
    } else if (command === "import" || command === "migrate") {
      if (!rest[0] || !entries.length)
        throw new Error("import/migrate requires a file and --session to establish scope");
      result = service.import(scope, resolve(rest[0]), command === "migrate");
    } else if (command === "settings")
      result = rest.length
        ? service.configSet({ ...service.config, ...(JSON.parse(rest.join(" ")) as object) })
        : {
            ...service.config,
            redactionPatterns: service.config.redactionPatterns.map(() => "[configured literal]"),
          };
    else
      result =
        "remendra-memory [--home DIR] [--project DIR] [--session FILE] status|doctor|sync|search|why|gaps|export|backup|import|migrate|settings";
    process.stdout.write(
      (typeof result === "string" ? result : JSON.stringify(result, null, 2)) + "\n",
    );
  } finally {
    service.close();
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`remendra: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

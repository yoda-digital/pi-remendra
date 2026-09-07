import { readFileSync, writeFileSync } from "node:fs";
import { MemoryStore } from "./store.js";
import { compilePacket, compileCheckpoint } from "./compiler.js";
import { loadConfig, saveConfig } from "./config.js";
import { importLegacy } from "./migration.js";
import { recall, type RecallRequest } from "./recall.js";
import { fetchEmbeddings } from "./embeddings.js";
import { estimateTokens, hash } from "./text.js";
import type {
  Actor,
  ClaimInput,
  Job,
  MemoryConfig,
  Scope,
  SearchQuery,
  SourceInput,
  TrialInput,
} from "./types.js";

/** Explicit RPC allowlist: model tools never receive arbitrary store methods. */
export class MemoryService {
  readonly store: MemoryStore;
  config: MemoryConfig;
  constructor(
    file: string,
    readonly directory: string,
  ) {
    this.config = loadConfig(directory);
    this.store = new MemoryStore(file);
  }
  project(path: string, linkTo?: string) {
    return this.store.project(path, linkTo);
  }
  ingest(scope: Scope, sources: SourceInput[]) {
    return this.store.ingest(
      scope,
      sources,
      this.config.redactionPatterns,
      this.config.excludedPaths,
    );
  }
  configGet() {
    return this.config;
  }
  configSet(raw: unknown) {
    return (this.config = saveConfig(this.directory, raw));
  }
  compile(scope: Scope, query: string, budget: number) {
    return compilePacket(this.store, scope, query, budget);
  }
  checkpoint(scope: Scope, query: string, budget: number) {
    return compileCheckpoint(this.store, scope, query, budget);
  }
  search(query: SearchQuery) {
    return this.store.search(query);
  }
  recall(scope: Scope, request: RecallRequest, sessionFile?: string) {
    return recall(this.store, scope, request, this.config, sessionFile);
  }
  record(scope: Scope, input: ClaimInput, actor: Actor) {
    return this.store.record(scope, input, actor);
  }
  correct(scope: Scope, id: string, revision: number, input: ClaimInput) {
    return this.store.correct(scope, id, revision, input);
  }
  change(
    scope: Scope,
    id: string,
    revision: number,
    action: Parameters<MemoryStore["change"]>[3],
    visibility?: "project" | "user",
  ) {
    return this.store.change(scope, id, revision, action, visibility);
  }
  erase(scope: Scope, id: string, revision: number) {
    return this.store.erase(scope, id, revision);
  }
  explain(scope: Scope, id: string) {
    return this.store.explain(id, scope);
  }
  gaps(scope: Scope) {
    return this.store.gaps(scope, 1000);
  }
  status(scope: Scope) {
    return this.store.status(scope);
  }
  trial(scope: Scope, input: TrialInput) {
    return this.store.trial(scope, input);
  }
  lease(
    scope: Scope,
    owner: string,
    input: number,
    reservation: number,
    limit: number,
    timeout: number,
  ) {
    return this.store.lease(scope, owner, input, reservation, limit, timeout);
  }
  complete(job: Job, scope: Scope, inputs: ClaimInput[], tokens: number, dollars?: number) {
    return this.store.completeJob(job, scope, inputs, tokens, dollars);
  }
  fail(job: Job, reason: string, tokens?: number, retryMs?: number) {
    return this.store.failJob(job, reason, tokens, retryMs);
  }
  doctor() {
    return this.store.doctor();
  }
  backup(file: string) {
    this.store.backup(file);
    return file;
  }
  export(scope: Scope, file?: string) {
    const text = this.store.exportData(scope);
    if (file) {
      writeFileSync(file, text, { flag: "wx", mode: 0o600 });
      return file;
    }
    return text;
  }
  import(scope: Scope, file: string, legacy = false) {
    const text = readFileSync(file, "utf8");
    return legacy ? importLegacy(this.store, scope, text) : this.store.importData(scope, text);
  }
  importLegacyEntries(scope: Scope, entries: unknown[]) {
    return importLegacy(this.store, scope, JSON.stringify(entries));
  }
  async embed(scope: Scope, query?: string) {
    const config = this.config.embeddings;
    if (!config) throw new Error("Configure an embedding endpoint and model first");
    const model = hash(JSON.stringify(config));
    const candidates = query ? [] : this.store.embeddingCandidates(scope, model);
    const selected: typeof candidates = [];
    let used = 0;
    for (const claim of candidates) {
      const tokens = estimateTokens(claim.text) + 16;
      if (used + tokens > this.config.observerInputTokens) break;
      selected.push(claim);
      used += tokens;
    }
    const texts = query ? [query] : selected.map((c) => c.text);
    if (!texts.length) return { indexed: 0, hits: [] };
    const reservation = texts.reduce((n, text) => n + estimateTokens(text) + 16, 256);
    const job = this.store.reserveUsage(scope, reservation, this.config.dailyTokenBudget, 12000);
    if (!job) throw new Error("Daily memory token budget exhausted");
    let usage: number | undefined;
    try {
      const result = await fetchEmbeddings(config, texts);
      usage = result.tokens;
      const hits = this.store.transaction(() => {
        for (let i = 0; i < selected.length; i++)
          this.store.putVector(
            scope,
            selected[i].id,
            selected[i].revision,
            model,
            result.vectors[i],
          );
        this.store.completeJob(job, scope, [], usage ?? reservation);
        return query ? this.store.semantic(scope, model, result.vectors[0]) : [];
      });
      return { indexed: selected.length, hits };
    } catch (error) {
      try {
        this.store.failJob(job, error instanceof Error ? error.message : String(error), usage);
      } catch (failError) {
        const msg = failError instanceof Error ? failError.message : String(failError);
        console.error("[remendra] embed failJob failed:", msg, "job:", job.id);
      }
      throw error;
    }
  }
  close() {
    this.store.close();
  }
}

export const RPC_METHODS = [
  "project",
  "ingest",
  "configGet",
  "configSet",
  "compile",
  "checkpoint",
  "search",
  "recall",
  "record",
  "correct",
  "change",
  "erase",
  "explain",
  "gaps",
  "status",
  "trial",
  "lease",
  "complete",
  "fail",
  "doctor",
  "backup",
  "export",
  "import",
  "importLegacyEntries",
  "embed",
  "close",
] as const;
export type Method = (typeof RPC_METHODS)[number];
export type Args<M extends Method> = Parameters<MemoryService[M]>;
export type Result<M extends Method> = Awaited<ReturnType<MemoryService[M]>>;

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "./store.js";
import { compilePacket, compileCheckpoint } from "./compiler.js";
import { loadConfig, saveConfig } from "./config.js";
import { importLegacy } from "./migration.js";
import { recall, type RecallRequest } from "./recall.js";
import {
  EMBED_TIMEOUT_MS,
  embeddingPrefixes,
  fetchEmbeddingsResilient,
  memoryEmbeddingText,
} from "./embeddings.js";
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
import { log } from "./log.js";
import { parseSessionFile, sessionInProject } from "./sessions.js";

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
  complete(
    job: Job,
    scope: Scope,
    inputs: ClaimInput[],
    tokens: number,
    dollars?: number,
    secondLook: number[] = [],
  ) {
    return this.store.completeJob(job, scope, inputs, tokens, dollars, secondLook);
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
  async embed(scope: Scope, query?: string, timeoutMs = EMBED_TIMEOUT_MS, allSessions = true) {
    const config = this.config.embeddings;
    if (!config) throw new Error("Configure an embedding endpoint and model first");
    // The key covers what was embedded, not just the endpoint: vectors made before prefixes
    // and cues are rebuilt automatically instead of being compared with new-style queries.
    const prefixes = embeddingPrefixes(config);
    const model = hash(JSON.stringify({ ...config, prefixes, text: "memory+cues" }));
    const candidates = query ? [] : this.store.embeddingCandidates(scope, model);
    const selected: typeof candidates = [];
    let used = 0;
    for (const claim of candidates) {
      const tokens = estimateTokens(memoryEmbeddingText(config, claim.text, claim.cues)) + 16;
      if (used + tokens > this.config.observerInputTokens) break;
      selected.push(claim);
      used += tokens;
    }
    const texts = query
      ? [prefixes.query + query]
      : selected.map((c) => memoryEmbeddingText(config, c.text, c.cues));
    if (!texts.length) return { indexed: 0, hits: [] };
    const reservation = texts.reduce((n, text) => n + estimateTokens(text) + 16, 256);
    const job = this.store.reserveUsage(
      scope,
      reservation,
      this.config.dailyTokenBudget,
      timeoutMs + 15000,
    );
    if (!job) throw new Error("Daily memory token budget exhausted");
    let usage: number | undefined;
    // Vectors are stored as each piece arrives: a cold server that crashes and reloads its
    // model (13-18 s a try) can run out the clock after some pieces already succeeded.
    let indexed = 0;
    let spent = 0;
    let unknownSpend = false;
    const store = (offset: number, vectors: number[][], tokens?: number) => {
      if (tokens === undefined) unknownSpend = true;
      else spent += tokens;
      if (query) return;
      // Embedding runs concurrently with other calls (see CONCURRENT_METHODS): a memory may
      // have been erased, revised or given cues meanwhile. Store only vectors that still
      // match the memory's current text.
      this.store.transaction(() => {
        vectors.forEach((vector, i) => {
          const claim = selected[offset + i];
          const now = this.store.claim(claim.id, scope, true);
          if (
            !now ||
            now.revision !== claim.revision ||
            memoryEmbeddingText(config, now.text, now.cues) !== texts[offset + i]
          )
            return;
          this.store.putVector(scope, claim.id, claim.revision, model, vector);
          indexed++;
        });
      });
    };
    try {
      const result = await fetchEmbeddingsResilient(config, texts, timeoutMs, store);
      usage = unknownSpend ? undefined : spent;
      const hits = this.store.transaction(() => {
        this.store.completeJob(job, scope, [], usage ?? reservation);
        return query ? this.store.semantic(scope, model, result.vectors[0], 20, allSessions) : [];
      });
      return { indexed, hits };
    } catch (error) {
      if (indexed) {
        // Keep what was stored; the rest is picked up by the next run.
        this.store.completeJob(job, scope, [], unknownSpend ? reservation : spent);
        log(
          `[remendra] embedded ${indexed} of ${texts.length} before: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { indexed, hits: [], incomplete: true };
      }
      try {
        this.store.failJob(job, error instanceof Error ? error.message : String(error), usage);
      } catch (failError) {
        const msg = failError instanceof Error ? failError.message : String(failError);
        log("[remendra] embed failJob failed:", msg, "job:", job.id);
      }
      throw error;
    }
  }
  sweepForPromotion(scope: Scope, minSettledTurns: number) {
    return this.store.sweepForPromotion(scope, minSettledTurns);
  }
  promoteOrphans(scope: Scope) {
    return this.store.promoteOrphans(scope);
  }
  cueCandidates(scope: Scope) {
    return this.store.cueCandidates(scope).map((c) => ({ id: c.id, text: c.text }));
  }
  reserveCues(scope: Scope, tokens: number, timeoutMs: number) {
    return this.store.reserveUsage(scope, tokens, this.config.dailyTokenBudget, timeoutMs);
  }
  addCues(
    job: Job,
    scope: Scope,
    updates: { id: string; cues: string[] }[],
    tokens: number,
    dollars?: number,
  ) {
    const changed = this.store.addCues(scope, updates);
    this.store.completeJob(job, scope, [], tokens, dollars);
    return changed;
  }
  indexSessions(
    scope: Scope,
    directory: string,
    projectPath?: string,
  ): { files: number; sources: number; skipped: number } {
    let files = 0,
      sources = 0,
      skipped = 0;
    const scanDir = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) {
            scanDir(full);
            continue;
          }
          if (!entry.endsWith(".jsonl") || stat.size > 64 * 1024 * 1024) {
            skipped++;
            continue;
          }
        } catch {
          skipped++;
          continue;
        }
        try {
          const parsed = parseSessionFile(readFileSync(full, "utf8"));
          // Only this project's sessions: the default directory holds every project's.
          if (!sessionInProject(parsed.cwd, projectPath)) {
            skipped++;
            continue;
          }
          const sessionSources = parsed.sources;
          if (sessionSources.length) {
            const result = this.store.ingest(
              { ...scope, sessionId: parsed.id ?? scope.sessionId, entryIds: [] },
              sessionSources,
              this.config.redactionPatterns,
              this.config.excludedPaths,
            );
            sources += result.keys.filter(Boolean).length;
            files++;
          }
        } catch {
          skipped++;
        }
      }
    };
    scanDir(directory);
    return { files, sources, skipped };
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
  "sweepForPromotion",
  "promoteOrphans",
  "cueCandidates",
  "reserveCues",
  "addCues",
  "indexSessions",
  "close",
] as const;
export type Method = (typeof RPC_METHODS)[number];
export type Args<M extends Method> = Parameters<MemoryService[M]>;
export type Result<M extends Method> = Awaited<ReturnType<MemoryService[M]>>;

import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, type Database, type SqlValue, type Statement } from "./sqlite.js";
import {
  CLAIM_KINDS,
  SCHEMA_VERSION,
  type Actor,
  type Claim,
  type ClaimInput,
  type Evidence,
  type Gap,
  type Job,
  type RecordResult,
  type Scope,
  type SearchHit,
  type SearchQuery,
  type Source,
  type SourceInput,
  type StoreStatus,
  type TrialInput,
} from "./types.js";
import {
  equivalent,
  estimateTokens,
  hash,
  jsonObject,
  normalize,
  redact,
  safeDate,
  terms,
} from "./text.js";

const parse = <T>(row: Record<string, unknown> | undefined, key = "data"): T | undefined =>
  row ? (JSON.parse(String(row[key])) as T) : undefined;
const nowISO = (): string => new Date().toISOString();

/** Synchronous by design: instantiated only inside a storage worker (or an isolated test/CLI). */
export class MemoryStore {
  private db: Database;
  private depth = 0;
  private statements = new Map<string, Statement>();
  private lastScopeKey = "";
  constructor(readonly file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = openDatabase(file);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;",
    );
    const version = Number(this.get("PRAGMA user_version")?.user_version ?? 0);
    if (version !== 0 && version !== SCHEMA_VERSION) {
      if (version > SCHEMA_VERSION) {
        this.db.close();
        throw new Error(
          `Memory schema ${version} is newer than supported ${SCHEMA_VERSION}; upgrade pi-remendra`,
        );
      }
      // Future: add incremental migrations here (e.g., version 2→3)
      this.db.close();
      throw new Error(
        `Memory schema ${version} requires migration to ${SCHEMA_VERSION}; no migration path available yet`,
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES('epoch','0');
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_paths(path TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id));
      CREATE TABLE IF NOT EXISTS sources(
        key TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, entry_id TEXT NOT NULL,
        hash TEXT NOT NULL, text TEXT NOT NULL, role TEXT NOT NULL, data TEXT NOT NULL,
        erased INTEGER NOT NULL DEFAULT 0, replaced INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS source_scope ON sources(project_id,session_id,entry_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(text,content='sources',content_rowid='rowid',tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS source_ai AFTER INSERT ON sources BEGIN INSERT INTO source_fts(rowid,text) VALUES(new.rowid,new.text); END;
      CREATE TRIGGER IF NOT EXISTS source_au AFTER UPDATE OF text ON sources BEGIN INSERT INTO source_fts(source_fts,rowid,text) VALUES('delete',old.rowid,old.text); INSERT INTO source_fts(rowid,text) VALUES(new.rowid,new.text); END;
      CREATE TABLE IF NOT EXISTS chunks(
        id INTEGER PRIMARY KEY, source_key TEXT NOT NULL REFERENCES sources(key), start INTEGER NOT NULL,end INTEGER NOT NULL,
        state TEXT NOT NULL, reason TEXT, job_id TEXT, retry_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE(source_key,start,end)
      );
      CREATE INDEX IF NOT EXISTS chunk_pending ON chunks(state,retry_at,id);
      CREATE TABLE IF NOT EXISTS claims(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, anchor TEXT NOT NULL,
        visibility TEXT NOT NULL,status TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,search TEXT NOT NULL,
        revision INTEGER NOT NULL,data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS claim_scope ON claims(project_id,visibility,status,session_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS claim_fts USING fts5(search,content='claims',content_rowid='rowid',tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS claim_ai AFTER INSERT ON claims BEGIN INSERT INTO claim_fts(rowid,search) VALUES(new.rowid,new.search); END;
      CREATE TRIGGER IF NOT EXISTS claim_au AFTER UPDATE OF search ON claims BEGIN INSERT INTO claim_fts(claim_fts,rowid,search) VALUES('delete',old.rowid,old.search); INSERT INTO claim_fts(rowid,search) VALUES(new.rowid,new.search); END;
      CREATE TRIGGER IF NOT EXISTS claim_ad AFTER DELETE ON claims BEGIN INSERT INTO claim_fts(claim_fts,rowid,search) VALUES('delete',old.rowid,old.search); END;
      CREATE TABLE IF NOT EXISTS evidence(claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,source_key TEXT NOT NULL REFERENCES sources(key),PRIMARY KEY(claim_id,source_key));
      CREATE INDEX IF NOT EXISTS evidence_source ON evidence(source_key);
      CREATE TABLE IF NOT EXISTS retired_spans(source_key TEXT NOT NULL REFERENCES sources(key),start INTEGER NOT NULL,end INTEGER NOT NULL,claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,PRIMARY KEY(source_key,start,end,claim_id));
      CREATE TABLE IF NOT EXISTS dependencies(claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,parent_id TEXT NOT NULL REFERENCES claims(id),revision INTEGER NOT NULL,PRIMARY KEY(claim_id,parent_id));
      CREATE INDEX IF NOT EXISTS dependents ON dependencies(parent_id);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,claim_id TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL,at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_history ON events(claim_id,seq);
      CREATE TABLE IF NOT EXISTS aliases(project_id TEXT NOT NULL,session_id TEXT NOT NULL,alias TEXT NOT NULL,claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,PRIMARY KEY(project_id,session_id,alias));
      CREATE TABLE IF NOT EXISTS erased_sources(source_key TEXT PRIMARY KEY,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS erased_claims(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,project_id TEXT NOT NULL,session_id TEXT NOT NULL,day TEXT NOT NULL,reserved INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budgets(day TEXT PRIMARY KEY,spent INTEGER NOT NULL DEFAULT 0,reserved INTEGER NOT NULL DEFAULT 0,dollars REAL NOT NULL DEFAULT 0,unknown_calls INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS trials(procedure_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,source_hash TEXT NOT NULL,source_key TEXT NOT NULL,outcome TEXT NOT NULL,environment TEXT NOT NULL,note TEXT NOT NULL,PRIMARY KEY(procedure_id,source_hash));
      CREATE TABLE IF NOT EXISTS vectors(claim_id TEXT PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE,revision INTEGER NOT NULL,model TEXT NOT NULL,dimensions INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors(path TEXT PRIMARY KEY,identity TEXT NOT NULL,offset INTEGER NOT NULL,tail TEXT NOT NULL);
      CREATE TEMP TABLE IF NOT EXISTS active_entries(id TEXT PRIMARY KEY);
      PRAGMA user_version=${SCHEMA_VERSION};
    `);
    if (file !== ":memory:" && existsSync(file)) chmodSync(file, 0o600);
  }

  private statement(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      if (this.statements.size >= 128) this.statements.delete(this.statements.keys().next().value!);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  private get(sql: string, ...args: SqlValue[]) {
    return this.statement(sql).get(...args);
  }
  private all(sql: string, ...args: SqlValue[]) {
    return this.statement(sql).all(...args);
  }
  private run(sql: string, ...args: SqlValue[]) {
    return this.statement(sql).run(...args);
  }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }
  snapshot<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec("BEGIN");
    this.depth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }
  close(): void {
    this.db.close();
  }
  epoch(): number {
    return Number(this.get("SELECT value FROM meta WHERE key='epoch'")?.value ?? 0);
  }
  private bump(): void {
    this.run("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='epoch'");
  }

  project(path: string, linkTo?: string): string {
    return this.transaction(() => {
      const existing = this.get("SELECT project_id FROM project_paths WHERE path=?", path);
      if (existing && !linkTo) return String(existing.project_id);
      if (linkTo && !this.get("SELECT id FROM projects WHERE id=?", linkTo))
        throw new Error("Project ID not found");
      const id = linkTo ?? randomUUID();
      if (!linkTo) this.run("INSERT INTO projects VALUES(?,?)", id, nowISO());
      this.run(
        "INSERT INTO project_paths VALUES(?,?) ON CONFLICT(path) DO UPDATE SET project_id=excluded.project_id",
        path,
        id,
      );
      return id;
    });
  }

  private setScope(scope: Scope): void {
    if (!scope.projectId || !scope.sessionId)
      throw new Error("Project and session scope are required");
    this.db.exec("DELETE FROM active_entries");
    const insert = this.statement("INSERT OR IGNORE INTO active_entries VALUES(?)");
    for (const entry of scope.entryIds) insert.run(entry);
  }

  private scopeSQL(scope: Scope, mode = "current", alias = "c"): { sql: string; args: SqlValue[] } {
    if (mode === "all") {
      return {
        sql: `((${alias}.project_id=? AND (${alias}.visibility IN ('project','lineage')))${scope.includeUser ? ` OR ${alias}.visibility='user'` : ""})`,
        args: [scope.projectId],
      };
    }
    return {
      sql: `((${alias}.project_id=? AND (${alias}.visibility='project' OR (${alias}.visibility='lineage' AND ${alias}.session_id=? AND ${alias}.anchor IN (SELECT id FROM active_entries))))${scope.includeUser ? ` OR ${alias}.visibility='user'` : ""})`,
      args: [scope.projectId, scope.sessionId],
    };
  }

  private inScope(claim: Claim, scope: Scope, all = false): boolean {
    if (claim.visibility === "user") return scope.includeUser === true;
    if (claim.projectId !== scope.projectId) return false;
    if (claim.visibility === "project") return true;
    // lineage: scope:all surfaces all project lineage claims across sessions
    if (all) return true;
    return claim.sessionId === scope.sessionId && scope.entryIds.includes(claim.anchor);
  }

  source(key: string): Source | undefined {
    const row = this.get("SELECT rowid AS ordinal,* FROM sources WHERE key=?", key);
    if (!row) return undefined;
    return {
      ...parse<SourceInput>(row)!,
      key,
      projectId: String(row.project_id),
      sessionId: String(row.session_id),
      hash: String(row.hash),
      text: String(row.text),
      ordinal: Number(row.ordinal),
      erased: Boolean(row.erased),
    };
  }

  ingest(
    scope: Scope,
    inputs: SourceInput[],
    patterns: string[] = [],
    excludedPaths: string[] = [],
  ): { inserted: number; keys: string[] } {
    return this.transaction(() => {
      this.setScope(scope);
      let inserted = 0;
      const keys: string[] = [];
      for (const input of inputs) {
        if (
          typeof input.entryId !== "string" ||
          !input.entryId ||
          typeof input.timestamp !== "string" ||
          !safeDate(input.timestamp) ||
          typeof input.text !== "string" ||
          !["user", "assistant", "toolResult", "branch_summary", "import"].includes(input.role)
        )
          throw new Error("Invalid source record");
        const text = redact(input.text, patterns);
        const digest = hash(
          JSON.stringify([
            input.role,
            text,
            input.timestamp,
            input.tool,
            input.target,
            input.isError,
          ]),
        );
        const key = hash(JSON.stringify([scope.projectId, scope.sessionId, input.entryId, digest]));
        keys.push(key);
        if (this.get("SELECT 1 FROM sources WHERE key=?", key)) continue;
        if (
          this.get(
            "SELECT 1 FROM erased_sources e JOIN sources s ON s.key=e.source_key WHERE s.project_id=? AND (e.source_key=? OR e.hash=?)",
            scope.projectId,
            key,
            digest,
          )
        ) {
          keys.pop();
          continue;
        }
        for (const old of this.all(
          "SELECT key FROM sources WHERE project_id=? AND session_id=? AND entry_id=? AND hash<>? AND replaced=0",
          scope.projectId,
          scope.sessionId,
          input.entryId,
          digest,
        )) {
          this.run("UPDATE sources SET replaced=1 WHERE key=?", String(old.key));
          // Clear stale FTS entry for replaced source
          this.run(
            "INSERT INTO source_fts(source_fts,rowid,text) VALUES('delete',(SELECT rowid FROM sources WHERE key=?),(SELECT text FROM sources WHERE key=?))",
            String(old.key),
            String(old.key),
          );
          this.run(
            "UPDATE chunks SET state='excluded',reason='source replaced' WHERE source_key=?",
            String(old.key),
          );
          for (const row of this.all(
            "SELECT claim_id FROM evidence WHERE source_key=?",
            String(old.key),
          ))
            this.invalidate(String(row.claim_id), true);
        }
        const excluded =
          input.target !== undefined && excludedPaths.some((p) => input.target!.includes(p));
        const oversized = Buffer.byteLength(text) > 8 * 1024 * 1024;
        const stored = oversized || excluded ? "" : text;
        const data: SourceInput = {
          ...input,
          target: input.target ? redact(input.target, patterns) : undefined,
          text: stored,
          hash: digest,
        };
        this.run(
          "INSERT INTO sources(key,project_id,session_id,entry_id,hash,text,role,data) VALUES(?,?,?,?,?,?,?,?)",
          key,
          scope.projectId,
          scope.sessionId,
          input.entryId,
          digest,
          stored,
          input.role,
          JSON.stringify(data),
        );
        if (oversized || excluded || !text) {
          this.run(
            "INSERT INTO chunks(source_key,start,end,state,reason) VALUES(?,?,?,?,?)",
            key,
            0,
            text.length,
            oversized ? "damaged" : "excluded",
            oversized
              ? "source exceeds 8 MiB; use original session"
              : excluded
                ? "path excluded by configuration"
                : "empty source",
          );
        } else {
          for (let start = 0; start < text.length;) {
            let end = Math.min(text.length, start + 1800);
            if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
            this.run(
              "INSERT INTO chunks(source_key,start,end,state) VALUES(?,?,?,'pending')",
              key,
              start,
              end,
            );
            start = end;
          }
        }
        inserted++;
      }
      if (inserted) this.bump();
      return { inserted, keys };
    });
  }

  private validateInput(input: ClaimInput, scope: Scope, actor: Actor): void {
    if (
      !CLAIM_KINDS.includes(input.kind) ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 12000
    )
      throw new Error("Claim requires a valid kind and 1–12000 characters");
    if (!Array.isArray(input.evidence) || input.evidence.length > 32)
      throw new Error("Invalid evidence list");
    if (
      !safeDate(input.validFrom) ||
      !safeDate(input.validUntil) ||
      (input.validFrom &&
        input.validUntil &&
        Date.parse(input.validFrom) >= Date.parse(input.validUntil))
    )
      throw new Error("Invalid validity interval");
    if (input.visibility && !["lineage", "project", "user"].includes(input.visibility))
      throw new Error("Invalid visibility");
    if (
      actor !== "user" &&
      actor !== "import" &&
      input.visibility &&
      input.visibility !== "lineage"
    )
      throw new Error("Only the user can promote memory scope");
    if (input.anchor && !scope.entryIds.includes(input.anchor))
      throw new Error("Claim anchor is outside the active lineage");
    for (const name of ["conditions", "cues", "alternatives"] as const) {
      if (
        input[name] &&
        (!Array.isArray(input[name]) ||
          input[name]!.length > 20 ||
          !input[name]!.every((x) => typeof x === "string" && x.length <= 2000))
      )
        throw new Error(`Invalid ${name}`);
    }
    for (const field of [
      "subject",
      "predicate",
      "value",
      "rationale",
      "environment",
      "alias",
    ] as const)
      if (
        input[field] !== undefined &&
        (typeof input[field] !== "string" || input[field]!.length > 4000)
      )
        throw new Error(`Invalid ${field}`);
    for (const e of input.evidence) {
      const source = this.source(e.sourceKey);
      if (
        !source ||
        source.erased ||
        !this.get("SELECT 1 FROM sources WHERE key=? AND replaced=0", e.sourceKey) ||
        source.hash !== e.hash ||
        source.projectId !== scope.projectId ||
        source.sessionId !== scope.sessionId ||
        !scope.entryIds.includes(source.entryId)
      )
        throw new Error("Evidence is missing, changed, erased, or outside this lineage");
      if (
        !Number.isInteger(e.start) ||
        !Number.isInteger(e.end) ||
        e.start < 0 ||
        e.end <= e.start ||
        e.end > source.text.length
      )
        throw new Error("Invalid source span");
    }
    if (
      input.dependsOn !== undefined &&
      (!Array.isArray(input.dependsOn) || input.dependsOn.length > 16)
    )
      throw new Error("Invalid dependencies");
    for (const d of input.dependsOn ?? []) {
      const parent = this.claim(d.id, scope);
      if (
        !parent ||
        parent.revision !== d.revision ||
        parent.status !== "active" ||
        !this.usable(parent, scope)
      )
        throw new Error("Dependency is unavailable or stale");
    }
  }

  private writeClaim(claim: Claim, action: string): void {
    const search = [
      claim.text,
      claim.subject,
      claim.predicate,
      claim.value,
      claim.rationale,
      ...(claim.cues ?? []),
      ...(claim.conditions ?? []),
      ...(claim.alternatives ?? []),
    ]
      .filter(Boolean)
      .join("\n");
    this.run(
      "INSERT INTO claims(id,project_id,session_id,anchor,visibility,status,kind,text,search,revision,data) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET visibility=excluded.visibility,status=excluded.status,text=excluded.text,search=excluded.search,revision=excluded.revision,data=excluded.data",
      claim.id,
      claim.projectId,
      claim.sessionId,
      claim.anchor,
      claim.visibility,
      claim.status,
      claim.kind,
      claim.text,
      search,
      claim.revision,
      JSON.stringify(claim),
    );
    this.run("DELETE FROM evidence WHERE claim_id=?", claim.id);
    for (const e of claim.evidence)
      this.run("INSERT OR IGNORE INTO evidence VALUES(?,?)", claim.id, e.sourceKey);
    this.run("DELETE FROM dependencies WHERE claim_id=?", claim.id);
    for (const d of claim.dependsOn)
      this.run("INSERT INTO dependencies VALUES(?,?,?)", claim.id, d.id, d.revision);
    this.run("DELETE FROM vectors WHERE claim_id=?", claim.id);
    this.run(
      "INSERT INTO events(claim_id,revision,action,at,data) VALUES(?,?,?,?,?)",
      claim.id,
      claim.revision,
      action,
      claim.updatedAt,
      JSON.stringify(claim),
    );
    this.bump();
  }

  private rawClaim(id: string): Claim | undefined {
    return parse<Claim>(this.get("SELECT data FROM claims WHERE id=?", id));
  }

  claim(id: string, scope: Scope, all = false): Claim | undefined {
    let claim = this.rawClaim(id);
    if (!claim) {
      const alias = this.get(
        "SELECT claim_id FROM aliases WHERE project_id=? AND session_id=? AND alias=?",
        scope.projectId,
        scope.sessionId,
        id,
      );
      if (alias) claim = this.rawClaim(String(alias.claim_id));
    }
    return claim && this.inScope(claim, scope, all) ? claim : undefined;
  }

  record(scope: Scope, input: ClaimInput, actor: Actor): RecordResult {
    return this.transaction(() => {
      input = { ...input };
      for (const key of [
        "text",
        "subject",
        "predicate",
        "value",
        "rationale",
        "environment",
      ] as const)
        if (typeof input[key] === "string") input[key] = redact(input[key]!);
      for (const key of ["conditions", "cues", "alternatives"] as const)
        if (Array.isArray(input[key])) input[key] = input[key]!.map((v) => redact(v));
      this.validateInput(input, scope, actor);
      const id = input.id ?? randomUUID();
      if (!/^[a-zA-Z0-9:_-]{8,160}$/.test(id)) throw new Error("Invalid claim ID");
      if (this.get("SELECT 1 FROM erased_claims WHERE id=?", id))
        throw new Error("Claim was erased");
      const existing = this.rawClaim(id);
      if (existing) {
        if (!this.inScope(existing, scope) || !equivalent(existing.text, input.text))
          throw new Error("Claim ID collision");
        return { claim: existing, duplicate: true, conflicts: [] };
      }
      const evidence = [
        ...new Map(input.evidence.map((e) => [`${e.sourceKey}:${e.start}:${e.end}`, e])).values(),
      ];
      const anchor =
        input.anchor ??
        (evidence.length
          ? this.source(evidence.at(-1)!.sourceKey)!.entryId
          : scope.entryIds.at(-1));
      if (!anchor) throw new Error("A memory needs a source or current session anchor");
      const time = nowISO();
      const claim: Claim = {
        ...input,
        id,
        text: redact(input.text),
        revision: 1,
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        visibility: input.visibility ?? "lineage",
        anchor,
        evidence,
        dependsOn: input.dependsOn ?? [],
        status:
          actor === "import" || !evidence.length || input.kind === "hypothesis"
            ? "candidate"
            : "active",
        actor,
        recordedAt: time,
        updatedAt: time,
        supersedes: [],
        hidden: false,
        pinned: false,
        verification: evidence.length ? "source_checked" : "unverified",
        procedureState: input.kind === "procedure" ? "candidate" : undefined,
      };
      // Re-extraction is allowed for auditability, but retired evidence cannot revive a fact.
      if (
        actor === "observer" &&
        evidence.some((e) =>
          this.get(
            "SELECT 1 FROM retired_spans WHERE source_key=? AND start<? AND end>?",
            e.sourceKey,
            e.end,
            e.start,
          ),
        )
      )
        claim.status = "stale";
      const conflicts: string[] = [];
      const canDispute = actor !== "import" && claim.status === "active";
      if (claim.subject && claim.predicate && claim.value !== undefined) {
        const conflictRows = [
          ...this.all(
            "SELECT data FROM claims WHERE project_id=? AND status IN ('active','disputed')",
            scope.projectId,
          ),
          ...this.all(
            "SELECT data FROM claims WHERE visibility='user' AND status IN ('active','disputed')",
          ),
        ];
        // Deduplicate by claim ID
        const seen = new Map<string, Record<string, unknown>>();
        for (const row of conflictRows) {
          const c = parse<Claim>(row)!;
          if (!seen.has(c.id)) seen.set(c.id, row);
        }
        for (const row of [...seen.values()]) {
          const other = parse<Claim>(row)!;
          if (
            !this.inScope(other, {
              ...scope,
              includeUser: claim.visibility === "user" || scope.includeUser,
            }) ||
            other.hidden ||
            other.visibility !== claim.visibility ||
            other.environment !== claim.environment
          )
            continue;
          if (
            normalize(other.subject ?? "") !== normalize(claim.subject) ||
            normalize(other.predicate ?? "") !== normalize(claim.predicate)
          )
            continue;
          const overlaps =
            (!other.validUntil ||
              !claim.validFrom ||
              Date.parse(other.validUntil) > Date.parse(claim.validFrom)) &&
            (!claim.validUntil ||
              !other.validFrom ||
              Date.parse(claim.validUntil) > Date.parse(other.validFrom));
          if (overlaps && other.value !== undefined && !equivalent(other.value, claim.value)) {
            conflicts.push(other.id);
            // An untrusted candidate cannot disable an established memory.
            if (canDispute) {
              other.status = "disputed";
              other.revision++;
              other.updatedAt = time;
              this.writeClaim(other, "disputed");
              this.invalidate(other.id);
              claim.status = "disputed";
            }
          }
        }
      }
      this.writeClaim(claim, "recorded");
      if (input.alias)
        this.run(
          "INSERT OR IGNORE INTO aliases VALUES(?,?,?,?)",
          scope.projectId,
          scope.sessionId,
          input.alias,
          claim.id,
        );
      return { claim, duplicate: false, conflicts };
    });
  }

  private invalidate(id: string, includeSelf = false): string[] {
    const visited = new Set<string>();
    const queue = includeSelf
      ? [id]
      : this.all("SELECT claim_id FROM dependencies WHERE parent_id=?", id).map((r) =>
          String(r.claim_id),
        );
    while (queue.length) {
      const next = queue.shift()!;
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(
        ...this.all("SELECT claim_id FROM dependencies WHERE parent_id=?", next).map((r) =>
          String(r.claim_id),
        ),
      );
      const claim = this.rawClaim(next);
      if (!claim || ["retracted", "superseded", "stale"].includes(claim.status)) continue;
      claim.status = "stale";
      claim.revision++;
      claim.updatedAt = nowISO();
      this.writeClaim(claim, "dependency_invalidated");
    }
    return [...visited];
  }

  correct(
    scope: Scope,
    id: string,
    expectedRevision: number,
    replacement: ClaimInput,
  ): RecordResult {
    return this.transaction(() => {
      const old = this.claim(id, scope);
      if (!old || old.revision !== expectedRevision)
        throw new Error("Revision conflict; inspect the current memory before correcting it");
      if (["retracted", "superseded"].includes(old.status))
        throw new Error("Cannot correct a retired claim");
      old.status = "superseded";
      old.revision++;
      old.updatedAt = nowISO();
      for (const e of old.evidence)
        this.run(
          "INSERT OR IGNORE INTO retired_spans VALUES(?,?,?,?)",
          e.sourceKey,
          e.start,
          e.end,
          old.id,
        );
      this.writeClaim(old, "superseded");
      this.invalidate(old.id);
      const result = this.record(
        scope,
        {
          ...replacement,
          id: undefined,
          visibility: old.visibility,
          subject: replacement.subject ?? old.subject,
          predicate: replacement.predicate ?? old.predicate,
        },
        "user",
      );
      result.claim.supersedes = [old.id];
      result.claim.pinned = old.pinned;
      result.claim.revision++;
      result.claim.updatedAt = nowISO();
      this.writeClaim(result.claim, "correction");
      // Remove the intermediate "recorded" event that record() wrote — only the correction is real
      this.run("DELETE FROM events WHERE claim_id=? AND action='recorded'", result.claim.id);
      return result;
    });
  }

  change(
    scope: Scope,
    id: string,
    expectedRevision: number,
    action: "pin" | "unpin" | "hide" | "show" | "retract" | "promote" | "accept",
    visibility?: "project" | "user",
  ): Claim {
    return this.transaction(() => {
      const claim = this.claim(id, scope, true);
      if (!claim || claim.revision !== expectedRevision)
        throw new Error("Revision conflict or memory outside scope");
      if (["retracted", "superseded"].includes(claim.status))
        throw new Error("Retired claims cannot be reactivated");
      if (action === "pin") claim.pinned = true;
      else if (action === "unpin") claim.pinned = false;
      else if (action === "hide") claim.hidden = true;
      else if (action === "show") claim.hidden = false;
      else if (action === "retract") {
        claim.status = "retracted";
        for (const e of claim.evidence)
          this.run(
            "INSERT OR IGNORE INTO retired_spans VALUES(?,?,?,?)",
            e.sourceKey,
            e.start,
            e.end,
            claim.id,
          );
      } else if (action === "promote") {
        if (!visibility) throw new Error("Promotion requires project or user visibility");
        claim.visibility = visibility;
      } else if (action === "accept") {
        if (claim.status !== "candidate")
          throw new Error(
            "Only a candidate can be accepted; resolve disputed/stale claims with a correction",
          );
        claim.status = "active";
        claim.actor = "user";
      }
      if (
        ["accept", "promote"].includes(action) &&
        claim.status === "active" &&
        claim.subject &&
        claim.predicate &&
        claim.value !== undefined
      ) {
        const changeConflictRows = [
          ...this.all(
            "SELECT data FROM claims WHERE project_id=? AND id<>? AND status IN ('active','disputed')",
            scope.projectId,
            claim.id,
          ),
          ...this.all(
            "SELECT data FROM claims WHERE visibility='user' AND id<>? AND status IN ('active','disputed')",
            claim.id,
          ),
        ];
        const changeSeen = new Map<string, Record<string, unknown>>();
        for (const row of changeConflictRows) {
          const c = parse<Claim>(row)!;
          if (!changeSeen.has(c.id)) changeSeen.set(c.id, row);
        }
        for (const row of [...changeSeen.values()]) {
          const other = parse<Claim>(row)!;
          if (
            !this.inScope(other, {
              ...scope,
              includeUser: claim.visibility === "user" || scope.includeUser,
            }) ||
            other.hidden ||
            other.visibility !== claim.visibility ||
            other.environment !== claim.environment
          )
            continue;
          if (
            normalize(other.subject ?? "") !== normalize(claim.subject) ||
            normalize(other.predicate ?? "") !== normalize(claim.predicate) ||
            other.value === undefined ||
            equivalent(other.value, claim.value)
          )
            continue;
          if (
            (other.validUntil &&
              claim.validFrom &&
              Date.parse(other.validUntil) <= Date.parse(claim.validFrom)) ||
            (claim.validUntil &&
              other.validFrom &&
              Date.parse(claim.validUntil) <= Date.parse(other.validFrom))
          )
            continue;
          claim.status = "disputed";
          other.status = "disputed";
          other.revision++;
          other.updatedAt = nowISO();
          this.writeClaim(other, "disputed");
          this.invalidate(other.id);
        }
      }
      claim.revision++;
      claim.updatedAt = nowISO();
      this.writeClaim(claim, action);
      this.invalidate(claim.id);
      return claim;
    });
  }

  private usable(claim: Claim, scope: Scope, at = nowISO(), visited = new Set<string>()): boolean {
    if (
      visited.has(claim.id) ||
      !this.inScope(claim, scope) ||
      claim.hidden ||
      claim.status !== "active"
    )
      return false;
    if (
      (claim.validFrom && Date.parse(claim.validFrom) > Date.parse(at)) ||
      (claim.validUntil && Date.parse(claim.validUntil) <= Date.parse(at))
    )
      return false;
    if (claim.environment && claim.environment !== scope.environment) return false;
    if (claim.kind === "procedure" && claim.procedureState !== "promoted") return false;
    visited.add(claim.id);
    for (const e of claim.evidence)
      if (
        !this.get(
          "SELECT 1 FROM sources WHERE key=? AND hash=? AND erased=0 AND replaced=0",
          e.sourceKey,
          e.hash,
        )
      )
        return false;
    for (const d of claim.dependsOn) {
      const parent = this.rawClaim(d.id);
      if (!parent || parent.revision !== d.revision || !this.usable(parent, scope, at, visited))
        return false;
    }
    return true;
  }

  private historicalUsable(
    claim: Claim,
    scope: Scope,
    at: string,
    seen = new Set<string>(),
  ): boolean {
    if (
      seen.has(claim.id) ||
      !this.inScope(claim, scope) ||
      claim.hidden ||
      claim.status !== "active"
    )
      return false;
    if (
      (claim.validFrom && Date.parse(claim.validFrom) > Date.parse(at)) ||
      (claim.validUntil && Date.parse(claim.validUntil) <= Date.parse(at))
    )
      return false;
    if (claim.environment && claim.environment !== scope.environment) return false;
    if (claim.kind === "procedure" && claim.procedureState !== "promoted") return false;
    seen.add(claim.id);
    for (const e of claim.evidence)
      if (
        !this.get("SELECT 1 FROM sources WHERE key=? AND hash=? AND erased=0", e.sourceKey, e.hash)
      )
        return false;
    for (const d of claim.dependsOn) {
      const parent = parse<Claim>(
        this.get(
          "SELECT data FROM events WHERE claim_id=? AND julianday(at)<=julianday(?) ORDER BY seq DESC LIMIT 1",
          d.id,
          at,
        ),
      );
      if (
        !parent ||
        parent.revision !== d.revision ||
        !this.historicalUsable(parent, scope, at, seen)
      )
        return false;
    }
    return true;
  }

  search(query: SearchQuery): SearchHit[] {
    this.setScope(query.scope);
    const filter = this.scopeSQL(query.scope, query.mode);
    const limit = Math.max(1, Math.min(200, query.limit ?? 20));
    const words = terms(query.text ?? "");
    let rows: Record<string, unknown>[];
    if (words.length) {
      const match = words.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
      rows = this.all(
        `SELECT c.data,bm25(claim_fts) AS rank FROM claim_fts JOIN claims c ON c.rowid=claim_fts.rowid WHERE claim_fts MATCH ? AND ${filter.sql} ORDER BY rank LIMIT 600`,
        match,
        ...filter.args,
      );
    } else
      rows = this.all(
        `SELECT c.data,0 AS rank FROM claims c WHERE ${filter.sql} ORDER BY c.rowid DESC LIMIT 600`,
        ...filter.args,
      );
    if (query.asOf) {
      if (!safeDate(query.asOf)) throw new Error("asOf requires an ISO timestamp with timezone");
      // Historical text may no longer match the current FTS index. Scan a bounded historical window.
      rows = this.all(
        `SELECT e.data,0 AS rank FROM events e JOIN claims c ON c.id=e.claim_id WHERE ${filter.sql} AND julianday(e.at)<=julianday(?) AND e.seq=(SELECT MAX(e2.seq) FROM events e2 WHERE e2.claim_id=e.claim_id AND julianday(e2.at)<=julianday(?)) ORDER BY e.seq DESC LIMIT 2000`,
        ...filter.args,
        query.asOf,
        query.asOf,
      );
    }
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const claim = parse<Claim>(row)!;
      if (query.kinds && !query.kinds.includes(claim.kind)) continue;
      const current = query.mode === undefined || query.mode === "current";
      if (query.asOf) {
        if (
          !this.inScope(claim, query.scope, query.mode === "all") ||
          claim.hidden ||
          (current && claim.status !== "active")
        )
          continue;
        if (current && !this.historicalUsable(claim, query.scope, query.asOf)) continue;
        if (
          words.length &&
          !words.some((t) =>
            terms(
              [claim.text, claim.subject, claim.value, ...(claim.cues ?? [])].join(" "),
            ).includes(t),
          )
        )
          continue;
      } else if (
        !this.inScope(claim, query.scope, query.mode === "all") ||
        (current && !this.usable(claim, query.scope))
      )
        continue;
      const reasons = [
        words.length ? "lexical match" : "recent memory",
        `scope:${claim.visibility}`,
        `status:${claim.status}`,
      ];
      let score =
        -Number(row.rank) +
        (claim.pinned ? 10 : 0) +
        (["constraint", "decision", "commitment"].includes(claim.kind) ? 2 : 0);
      if (query.text && equivalent(claim.text, query.text)) {
        score += 20;
        reasons.push("exact text");
      }
      if (claim.verification === "outcome_checked") {
        score += 1;
        reasons.push("outcome checked");
      }
      hits.push({ claim, score, reasons });
    }
    return hits
      .sort((a, b) => b.score - a.score || a.claim.id.localeCompare(b.claim.id))
      .slice(0, limit);
  }

  cautions(scope: Scope): Claim[] {
    this.setScope(scope);
    const f = this.scopeSQL(scope);
    return this.all(
      `SELECT c.data FROM claims c WHERE ${f.sql} AND c.status IN ('disputed','stale','superseded','retracted') ORDER BY c.rowid DESC LIMIT 200`,
      ...f.args,
    ).map((r) => parse<Claim>(r)!);
  }

  anchors(scope: Scope): SearchHit[] {
    this.setScope(scope);
    const f = this.scopeSQL(scope);
    return this.all(
      `SELECT c.data FROM claims c WHERE ${f.sql} AND c.status='active' AND (c.kind IN ('constraint','preference','commitment','decision') OR json_extract(c.data,'$.pinned')=1) ORDER BY c.rowid DESC LIMIT 300`,
      ...f.args,
    )
      .map((r) => parse<Claim>(r)!)
      .filter((c) => this.usable(c, scope))
      .map((claim) => ({
        claim,
        score: claim.pinned ? 20 : 3,
        reasons: [claim.pinned ? "user pinned" : `active ${claim.kind}`],
      }));
  }

  gaps(scope: Scope, limit = 100): Gap[] {
    this.setScope(scope);
    return this.all(
      "SELECT c.*,s.entry_id FROM chunks c JOIN sources s ON s.key=c.source_key WHERE s.project_id=? AND s.session_id=? AND s.entry_id IN (SELECT id FROM active_entries) AND c.state NOT IN ('processed','excluded') ORDER BY s.rowid,c.start LIMIT ?",
      scope.projectId,
      scope.sessionId,
      Math.min(1000, limit),
    ).map((r) => ({
      sourceKey: String(r.source_key),
      entryId: String(r.entry_id),
      start: Number(r.start),
      end: Number(r.end),
      state: String(r.state) as Gap["state"],
      reason: r.reason ? String(r.reason) : undefined,
    }));
  }

  sourceSearch(scope: Scope, text: string, all = false, limit = 20): Source[] {
    this.setScope(scope);
    const words = terms(text);
    if (!words.length) return [];
    const match = words.map((t) => `"${t}"`).join(" OR ");
    return this.all(
      `SELECT s.key FROM source_fts JOIN sources s ON s.rowid=source_fts.rowid WHERE source_fts MATCH ? AND s.project_id=? AND s.erased=0 AND s.replaced=0 AND (?=1 OR (s.session_id=? AND s.entry_id IN (SELECT id FROM active_entries))) ORDER BY bm25(source_fts) LIMIT ?`,
      match,
      scope.projectId,
      all ? 1 : 0,
      scope.sessionId,
      Math.min(100, limit),
    ).map((r) => this.source(String(r.key))!);
  }

  explain(
    id: string,
    scope: Scope,
  ): {
    claim: Claim;
    evidence: Array<{ ref: Evidence; excerpt: string; available: boolean }>;
    history: Array<{ action: string; at: string; revision: number }>;
    dependents: string[];
  } {
    const claim = this.claim(id, scope, true);
    if (!claim) throw new Error("Memory not found in this scope");
    return {
      claim,
      evidence: claim.evidence.map((ref) => {
        const s = this.source(ref.sourceKey);
        return {
          ref,
          available: !!s && !s.erased && s.hash === ref.hash,
          excerpt: s && !s.erased ? s.text.slice(ref.start, ref.end) : "[source unavailable]",
        };
      }),
      history: this.all(
        "SELECT action,at,revision FROM events WHERE claim_id=? ORDER BY seq",
        claim.id,
      ).map((r) => ({ action: String(r.action), at: String(r.at), revision: Number(r.revision) })),
      dependents: this.all("SELECT claim_id FROM dependencies WHERE parent_id=?", claim.id)
        .map((r) => String(r.claim_id))
        .filter((x) => this.claim(x, scope) !== undefined),
    };
  }

  lease(
    scope: Scope,
    owner: string,
    inputTokens: number,
    reservation: number,
    dailyLimit: number,
    timeoutMs: number,
    now = Date.now(),
  ): Job | undefined {
    return this.transaction(() => {
      this.setScope(scope);
      this.recoverJobs(now);
      const day = new Date(now).toISOString().slice(0, 10);
      this.run("INSERT OR IGNORE INTO budgets(day) VALUES(?)", day);
      const budget = this.get("SELECT spent,reserved FROM budgets WHERE day=?", day)!;
      if (Number(budget.spent) + Number(budget.reserved) + reservation > dailyLimit)
        return undefined;
      if (
        ![inputTokens, reservation, dailyLimit, timeoutMs].every(
          (x) => Number.isSafeInteger(x) && x > 0,
        ) ||
        reservation < inputTokens
      )
        throw new Error("Invalid job limits");
      const rows = this.all(
        "SELECT c.* FROM chunks c JOIN sources s ON s.key=c.source_key WHERE c.state='pending' AND c.retry_at<=? AND s.project_id=? AND s.session_id=? AND s.erased=0 AND s.replaced=0 AND s.entry_id IN (SELECT id FROM active_entries) ORDER BY s.rowid,c.start LIMIT 64",
        now,
        scope.projectId,
        scope.sessionId,
      );
      const chunks: Job["chunks"] = [];
      let used = 0;
      for (const row of rows) {
        const source = this.source(String(row.source_key))!;
        const start = Number(row.start);
        let end = Number(row.end);
        const remaining = inputTokens - used - 160;
        if (remaining <= 0) break;
        if (estimateTokens(JSON.stringify(source.text.slice(start, end))) > remaining) {
          if (chunks.length) break;
          const previousEnd = end;
          while (
            end > start &&
            estimateTokens(JSON.stringify(source.text.slice(start, end))) > remaining
          )
            end = start + Math.floor((end - start) * 0.75);
          if (end <= start) break;
          if (/[\uD800-\uDBFF]/.test(source.text[end - 1])) end--;
          this.run("UPDATE chunks SET end=? WHERE id=?", end, Number(row.id));
          this.run(
            "INSERT OR IGNORE INTO chunks(source_key,start,end,state) VALUES(?,?,?,'pending')",
            source.key,
            end,
            previousEnd,
          );
        }
        used += estimateTokens(JSON.stringify(source.text.slice(start, end))) + 160;
        chunks.push({ id: Number(row.id), source, start, end });
      }
      if (!chunks.length) return undefined;
      const job: Job = {
        id: randomUUID(),
        owner,
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        chunks,
        reservedTokens: reservation,
        expiresAt: now + timeoutMs,
      };
      this.run(
        "INSERT INTO jobs VALUES(?,?,?,?,?,?,?,'leased')",
        job.id,
        owner,
        scope.projectId,
        scope.sessionId,
        day,
        reservation,
        job.expiresAt,
      );
      this.run("UPDATE budgets SET reserved=reserved+? WHERE day=?", reservation, day);
      for (const chunk of chunks)
        this.run("UPDATE chunks SET state='leased',job_id=? WHERE id=?", job.id, chunk.id);
      return job;
    });
  }

  completeJob(
    job: Job,
    scope: Scope,
    inputs: ClaimInput[],
    actualTokens: number,
    dollars?: number,
  ): Claim[] {
    return this.transaction(() => {
      this.assertJob(job);
      if (scope.projectId !== job.projectId || scope.sessionId !== job.sessionId)
        throw new Error("Stale job scope");
      for (const chunk of job.chunks)
        if (
          !this.get(
            "SELECT 1 FROM chunks c JOIN sources s ON s.key=c.source_key WHERE c.id=? AND c.job_id=? AND c.state='leased' AND s.erased=0 AND s.replaced=0",
            chunk.id,
            job.id,
          ) ||
          !scope.entryIds.includes(chunk.source.entryId)
        )
          throw new Error("Job source changed or left active lineage");
      const allowed = new Map(job.chunks.map((c) => [c.source.key, c.source]));
      for (const input of inputs)
        for (const e of input.evidence) {
          if (
            !allowed.has(e.sourceKey) ||
            !job.chunks.some(
              (c) => c.source.key === e.sourceKey && e.start >= c.start && e.end <= c.end,
            )
          )
            throw new Error("Observer cited evidence outside its leased input");
        }
      const records = inputs.map((c) => this.record(scope, c, "observer").claim);
      this.run(
        "UPDATE chunks SET state='processed',job_id=NULL,reason=NULL WHERE job_id=? AND state='leased'",
        job.id,
      );
      this.settleJob(job, actualTokens, dollars, "complete");
      return records;
    });
  }

  failJob(job: Job, reason: string, actualTokens?: number, retryMs = 30000): void {
    this.transaction(() => {
      this.assertJob(job);
      this.run(
        "UPDATE chunks SET state='pending',job_id=NULL,reason=?,retry_at=? WHERE job_id=? AND state='leased'",
        redact(reason).slice(0, 500),
        Date.now() + retryMs,
        job.id,
      );
      this.settleJob(job, actualTokens ?? job.reservedTokens, undefined, "failed");
    });
  }

  private assertJob(job: Job): void {
    if (
      !this.get(
        "SELECT 1 FROM jobs WHERE id=? AND owner=? AND state='leased' AND expires_at>?",
        job.id,
        job.owner,
        Date.now(),
      )
    )
      throw new Error("Job lease expired or no longer owned");
  }
  private settleJob(job: Job, tokens: number, dollars: number | undefined, state: string): void {
    if (
      !Number.isFinite(tokens) ||
      tokens < 0 ||
      (dollars !== undefined && (!Number.isFinite(dollars) || dollars < 0))
    )
      throw new Error("Invalid usage");
    const row = this.get("SELECT day,reserved FROM jobs WHERE id=?", job.id)!;
    this.run(
      "UPDATE budgets SET reserved=MAX(0,reserved-?),spent=spent+?,dollars=dollars+?,unknown_calls=unknown_calls+? WHERE day=?",
      Number(row.reserved),
      Math.ceil(tokens),
      dollars ?? 0,
      dollars === undefined ? 1 : 0,
      String(row.day),
    );
    this.run("UPDATE jobs SET state=? WHERE id=?", state, job.id);
  }
  private recoverJobs(now: number): void {
    for (const row of this.all("SELECT * FROM jobs WHERE state='leased' AND expires_at<=?", now)) {
      this.run(
        "UPDATE chunks SET state='pending',job_id=NULL,reason='expired lease; awaiting retry' WHERE job_id=? AND state='leased'",
        String(row.id),
      );
      this.run(
        "UPDATE budgets SET reserved=MAX(0,reserved-?),spent=spent+?,unknown_calls=unknown_calls+1 WHERE day=?",
        Number(row.reserved),
        Number(row.reserved),
        String(row.day),
      );
      this.run("UPDATE jobs SET state='expired' WHERE id=?", String(row.id));
    }
  }

  status(scope: Scope): StoreStatus {
    this.setScope(scope);
    const f = this.scopeSQL(scope, "all");
    const day = nowISO().slice(0, 10);
    const budget = this.get("SELECT * FROM budgets WHERE day=?", day);
    const claims = Object.fromEntries(
      this.all(
        `SELECT c.status,COUNT(*) AS n FROM claims c WHERE ${f.sql} GROUP BY c.status`,
        ...f.args,
      ).map((r) => [String(r.status), Number(r.n)]),
    );
    const gaps = Object.fromEntries(
      this.all(
        "SELECT c.state,COUNT(*) AS n FROM chunks c JOIN sources s ON s.key=c.source_key WHERE s.project_id=? AND s.session_id=? AND s.entry_id IN (SELECT id FROM active_entries) GROUP BY c.state",
        scope.projectId,
        scope.sessionId,
      ).map((r) => [String(r.state), Number(r.n)]),
    );
    return {
      epoch: this.epoch(),
      claims,
      sources: Number(
        this.get("SELECT COUNT(*) AS n FROM sources WHERE project_id=?", scope.projectId)?.n ?? 0,
      ),
      gaps,
      budget: {
        day,
        spent: Number(budget?.spent ?? 0),
        reserved: Number(budget?.reserved ?? 0),
        dollars: Number(budget?.dollars ?? 0),
        unknownCostCalls: Number(budget?.unknown_calls ?? 0),
      },
    };
  }

  trial(scope: Scope, input: TrialInput): Claim {
    return this.transaction(() => {
      const claim = this.claim(input.procedureId, scope);
      const source = this.source(input.sourceKey);
      if (
        !claim ||
        claim.kind !== "procedure" ||
        claim.revision !== input.expectedRevision ||
        !source ||
        source.erased ||
        source.role !== "toolResult" ||
        source.projectId !== scope.projectId ||
        source.sessionId !== scope.sessionId ||
        !scope.entryIds.includes(source.entryId)
      )
        throw new Error("Trial needs a current procedure and tool-result evidence in this lineage");
      if (
        !input.environment ||
        !["success", "failure"].includes(input.outcome) ||
        !source.text ||
        (input.outcome === "success" && source.isError !== false) ||
        (input.outcome === "failure" && source.isError !== true)
      )
        throw new Error("Trial outcome does not match the tool evidence");
      const inserted = this.run(
        "INSERT OR IGNORE INTO trials VALUES(?,?,?,?,?,?)",
        claim.id,
        source.hash,
        source.key,
        input.outcome,
        input.environment,
        redact(input.note).slice(0, 2000),
      );
      if (!Number(inserted.changes)) return claim;
      const successes = Number(
        this.get(
          "SELECT COUNT(*) AS n FROM trials WHERE procedure_id=? AND environment=? AND outcome='success' AND rowid>COALESCE((SELECT MAX(rowid) FROM trials WHERE procedure_id=? AND environment=? AND outcome='failure'),0)",
          claim.id,
          input.environment,
          claim.id,
          input.environment,
        )?.n ?? 0,
      );
      claim.procedureState =
        input.outcome === "failure" ? "candidate" : successes >= 2 ? "promoted" : "trial_supported";
      claim.environment = input.environment;
      claim.verification = "outcome_checked";
      claim.revision++;
      claim.updatedAt = nowISO();
      claim.evidence = [
        ...claim.evidence,
        { sourceKey: source.key, hash: source.hash, start: 0, end: source.text.length },
      ];
      this.writeClaim(claim, `trial_${input.outcome}`);
      this.invalidate(claim.id);
      return claim;
    });
  }

  erase(
    scope: Scope,
    id: string,
    expectedRevision: number,
  ): { claims: number; sources: number; note: string } {
    return this.transaction(() => {
      const claim = this.claim(id, scope, true);
      if (!claim || claim.revision !== expectedRevision)
        throw new Error("Revision conflict or memory not found");
      const sourceKeys = new Set(claim.evidence.map((e) => e.sourceKey));
      const ids = new Set([claim.id, ...this.invalidate(claim.id)]);
      for (const key of sourceKeys)
        for (const row of this.all("SELECT claim_id FROM evidence WHERE source_key=?", key)) {
          ids.add(String(row.claim_id));
          for (const d of this.invalidate(String(row.claim_id))) ids.add(d);
        }
      for (const key of sourceKeys) {
        const source = this.source(key)!;
        this.run("INSERT OR IGNORE INTO erased_sources VALUES(?,?)", key, source.hash);
        this.run(
          "UPDATE sources SET text='',data=?,erased=1 WHERE key=?",
          JSON.stringify({ ...source, text: "" }),
          key,
        );
        this.run(
          "UPDATE chunks SET state='excluded',reason='erased',job_id=NULL WHERE source_key=?",
          key,
        );
      }
      // Remove edges first to satisfy cross-claim foreign keys, then scrub all historical payloads.
      for (const key of ids)
        this.run("DELETE FROM dependencies WHERE parent_id=? OR claim_id=?", key, key);
      for (const key of ids) {
        this.run("INSERT OR IGNORE INTO erased_claims VALUES(?)", key);
        this.run("DELETE FROM events WHERE claim_id=?", key);
        this.run("DELETE FROM claims WHERE id=?", key);
      }
      this.bump();
      return {
        claims: ids.size,
        sources: sourceKeys.size,
        note: "Removed from v2 memory and prevented re-ingestion. Original Pi sessions, backups, and previous exports remain separate.",
      };
    });
  }

  doctor(): Record<string, unknown> {
    return {
      schema: SCHEMA_VERSION,
      integrity: this.get("PRAGMA quick_check"),
      foreignKeys: this.all("PRAGMA foreign_key_check"),
      epoch: this.epoch(),
      runtime: "Bun" in globalThis ? "bun" : "node",
      sqlite: this.get("SELECT sqlite_version() AS version"),
      expiredLeases: Number(
        this.get(
          "SELECT COUNT(*) AS n FROM jobs WHERE state='leased' AND expires_at<=?",
          Date.now(),
        )?.n ?? 0,
      ),
      pendingChunks: Number(
        this.get("SELECT COUNT(*) AS n FROM chunks WHERE state='pending'")?.n ?? 0,
      ),
      failedJobs: Number(this.get("SELECT COUNT(*) AS n FROM jobs WHERE state='failed'")?.n ?? 0),
      damagedChunks: Number(
        this.get("SELECT COUNT(*) AS n FROM chunks WHERE state='damaged'")?.n ?? 0,
      ),
      chunkBacklog: Object.fromEntries(
        this.all("SELECT state, COUNT(*) AS n FROM chunks GROUP BY state").map((r) => [
          String(r.state),
          Number(r.n),
        ]),
      ),
    };
  }

  backup(path: string): void {
    if (existsSync(path)) throw new Error("Backup destination already exists");
    this.run("VACUUM INTO ?", path);
    chmodSync(path, 0o600);
  }

  cursor(path: string): { identity: string; offset: number; tail: string } | undefined {
    const r = this.get("SELECT * FROM cursors WHERE path=?", path);
    return r
      ? { identity: String(r.identity), offset: Number(r.offset), tail: String(r.tail) }
      : undefined;
  }
  setCursor(path: string, identity: string, offset: number, tail: string): void {
    this.run(
      "INSERT INTO cursors VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET identity=excluded.identity,offset=excluded.offset,tail=excluded.tail",
      path,
      identity,
      offset,
      tail,
    );
  }

  exportData(scope: Scope): string {
    this.setScope(scope);
    const f = this.scopeSQL(scope, "all");
    const claims = this.all(
      `SELECT c.data FROM claims c WHERE ${f.sql} ORDER BY c.rowid`,
      ...f.args,
    ).map((r) => parse<Claim>(r)!);
    const keys = new Set(claims.flatMap((c) => c.evidence.map((e) => e.sourceKey)));
    const records: unknown[] = [
      { type: "remendra_export", version: 2, createdAt: nowISO(), projectId: scope.projectId },
    ];
    for (const key of keys) records.push({ type: "source", data: this.source(key) });
    for (const claim of claims) records.push({ type: "claim", data: claim });
    for (const claim of claims)
      for (const event of this.all(
        "SELECT action,at,data FROM events WHERE claim_id=? ORDER BY seq",
        claim.id,
      ))
        records.push({
          type: "event",
          action: event.action,
          at: event.at,
          data: parse<Claim>(event),
        });
    for (const row of this.all(
      "SELECT e.source_key,e.hash FROM erased_sources e JOIN sources s ON s.key=e.source_key WHERE s.project_id=?",
      scope.projectId,
    ))
      records.push({ type: "erased_source", data: row });
    for (const row of this.all("SELECT * FROM aliases WHERE project_id=?", scope.projectId))
      records.push({ type: "alias", data: row });
    for (const row of this.all(
      "SELECT rs.* FROM retired_spans rs JOIN sources s ON s.key=rs.source_key WHERE s.project_id=?",
      scope.projectId,
    ))
      records.push({ type: "retired_span", data: row });
    for (const row of this.all(
      "SELECT t.* FROM trials t JOIN claims c ON c.id=t.procedure_id WHERE c.project_id=?",
      scope.projectId,
    ))
      records.push({ type: "trial", data: row });
    return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  }

  importData(scope: Scope, text: string): { sources: number; claims: number } {
    if (Buffer.byteLength(text) > 20 * 1024 * 1024)
      throw new Error("Import exceeds 20 MiB; split the file");
    const rows = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    if (
      !jsonObject(rows[0]) ||
      !["remendra_export", "blackhole_export"].includes(String(rows[0].type)) ||
      rows[0].version !== 2
    )
      throw new Error("Expected a v2 JSONL export");
    return this.transaction(() => {
      const refs = new Map<string, Source>();
      const erasedRefs = new Set<string>();
      let sources = 0,
        claims = 0;
      const idMap = new Map<string, string>();
      const importedScope = { ...scope, entryIds: [...scope.entryIds] };
      for (const row of rows) {
        if (!jsonObject(row) || row.type !== "source" || !jsonObject(row.data)) continue;
        const s = row.data;
        if (
          typeof s.key !== "string" ||
          typeof s.text !== "string" ||
          typeof s.timestamp !== "string"
        )
          throw new Error("Malformed imported source");
        if (
          s.erased === true ||
          this.get(
            "SELECT 1 FROM erased_sources e JOIN sources s ON s.key=e.source_key WHERE s.project_id=? AND (e.source_key=? OR e.hash=?)",
            scope.projectId,
            s.key,
            String(s.hash ?? ""),
          )
        ) {
          erasedRefs.add(s.key);
          continue;
        }
        const entryId = `import:${hash(s.key).slice(0, 32)}`;
        const result = this.ingest(importedScope, [
          { entryId, role: "import", text: s.text, timestamp: s.timestamp },
        ]);
        const imported = result.keys[0] ? this.source(result.keys[0]) : undefined;
        if (!imported || imported.erased) {
          erasedRefs.add(s.key);
          continue;
        }
        refs.set(s.key, imported);
        importedScope.entryIds.push(entryId);
        sources += result.inserted;
      }
      for (const row of rows) {
        if (!jsonObject(row) || row.type !== "claim" || !jsonObject(row.data)) continue;
        const c = row.data as unknown as Claim;
        if (!Array.isArray(c.evidence)) throw new Error("Malformed imported claim");
        if (
          this.get("SELECT 1 FROM erased_claims WHERE id=?", c.id) ||
          c.evidence.some((e) => erasedRefs.has(e.sourceKey))
        )
          continue;
        if (c.evidence.some((e) => !refs.has(e.sourceKey)))
          throw new Error("Imported claim has a missing source");
        const evidence = c.evidence.flatMap((e) => {
          const s = refs.get(e.sourceKey);
          return s ? [{ ...e, sourceKey: s.key, hash: s.hash }] : [];
        });
        const newId = `import:${hash(`${scope.projectId}:${scope.sessionId}:${c.id}`).slice(0, 40)}`;
        const input: ClaimInput = {
          id: newId,
          text: c.text,
          kind: c.kind,
          evidence,
          anchor: scope.entryIds.at(-1),
          visibility: c.visibility,
          conditions: c.conditions,
          cues: c.cues,
          rationale: c.rationale,
          alternatives: c.alternatives,
          subject: c.subject,
          predicate: c.predicate,
          value: c.value,
          validFrom: c.validFrom,
          validUntil: c.validUntil,
          environment: c.environment,
        };
        idMap.set(c.id, newId);
        const result = this.record(importedScope, input, "import");
        if (!result.duplicate) claims++;
        // Remap supersedes and dependsOn using the old→new ID mapping
        if (Array.isArray(c.supersedes) && c.supersedes.length) {
          const mapped = c.supersedes
            .map((old: string) => idMap.get(old) ?? old)
            .filter((id: string) => id !== newId);
          if (mapped.length) {
            result.claim.supersedes = mapped;
            result.claim.revision++;
            result.claim.updatedAt = new Date().toISOString();
            this.writeClaim(result.claim, "import_supersedes");
          }
        }
      }
      return { sources, claims };
    });
  }

  putVector(scope: Scope, id: string, revision: number, model: string, vector: number[]): void {
    const claim = this.claim(id, scope);
    if (
      !claim ||
      claim.revision !== revision ||
      !vector.length ||
      vector.length > 8192 ||
      !vector.every(Number.isFinite)
    )
      throw new Error("Invalid or stale embedding");
    this.run(
      "INSERT INTO vectors VALUES(?,?,?,?,?) ON CONFLICT(claim_id) DO UPDATE SET revision=excluded.revision,model=excluded.model,dimensions=excluded.dimensions,data=excluded.data",
      id,
      revision,
      model,
      vector.length,
      JSON.stringify(vector),
    );
  }

  embeddingCandidates(scope: Scope, model: string, limit = 32): Claim[] {
    this.setScope(scope);
    const f = this.scopeSQL(scope);
    return this.all(
      `SELECT c.data FROM claims c LEFT JOIN vectors v ON v.claim_id=c.id AND v.revision=c.revision AND v.model=? WHERE ${f.sql} AND c.status='active' AND v.claim_id IS NULL ORDER BY c.rowid DESC LIMIT 200`,
      model,
      ...f.args,
    )
      .map((r) => parse<Claim>(r)!)
      .filter((c) => this.usable(c, scope))
      .slice(0, limit);
  }

  reserveUsage(
    scope: Scope,
    reservation: number,
    dailyLimit: number,
    timeout: number,
  ): Job | undefined {
    if (!Number.isSafeInteger(reservation) || reservation <= 0)
      throw new Error("Invalid reservation");
    return this.transaction(() => {
      this.recoverJobs(Date.now());
      const day = nowISO().slice(0, 10);
      this.run("INSERT OR IGNORE INTO budgets(day) VALUES(?)", day);
      const budget = this.get("SELECT spent,reserved FROM budgets WHERE day=?", day)!;
      if (Number(budget.spent) + Number(budget.reserved) + reservation > dailyLimit)
        return undefined;
      const job: Job = {
        id: randomUUID(),
        owner: randomUUID(),
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        chunks: [],
        reservedTokens: reservation,
        expiresAt: Date.now() + timeout,
      };
      this.run(
        "INSERT INTO jobs VALUES(?,?,?,?,?,?,?,'leased')",
        job.id,
        job.owner,
        scope.projectId,
        scope.sessionId,
        day,
        reservation,
        job.expiresAt,
      );
      this.run("UPDATE budgets SET reserved=reserved+? WHERE day=?", reservation, day);
      return job;
    });
  }

  semantic(scope: Scope, model: string, vector: number[], limit = 20): SearchHit[] {
    if (!vector.length || vector.length > 8192 || !vector.every(Number.isFinite))
      throw new Error("Invalid query vector");
    this.setScope(scope);
    const f = this.scopeSQL(scope);
    const norm = Math.hypot(...vector);
    if (!norm) return [];
    const hits: SearchHit[] = [];
    // Optional local scan is deliberately bounded; large deployments should replace this adapter.
    for (const row of this.all(
      `SELECT c.data,v.data AS vector FROM vectors v JOIN claims c ON c.id=v.claim_id AND c.revision=v.revision WHERE ${f.sql} AND v.model=? AND v.dimensions=? LIMIT 10000`,
      ...f.args,
      model,
      vector.length,
    )) {
      const claim = parse<Claim>(row)!;
      if (!this.usable(claim, scope)) continue;
      const v = JSON.parse(String(row.vector)) as number[];
      const denominator = norm * Math.hypot(...v);
      if (!denominator) continue;
      const score = v.reduce((sum, x, i) => sum + x * vector[i], 0) / denominator;
      hits.push({ claim, score, reasons: ["semantic match", `scope:${claim.visibility}`] });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, Math.min(100, limit));
  }
}

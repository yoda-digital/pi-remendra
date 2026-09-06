/** Versioned, serializable contracts shared by the host and storage worker. */
export const SCHEMA_VERSION = 2;
export const CLAIM_KINDS = [
  "fact",
  "decision",
  "constraint",
  "preference",
  "hypothesis",
  "procedure",
  "commitment",
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export type ClaimStatus =
  | "candidate"
  | "active"
  | "disputed"
  | "stale"
  | "superseded"
  | "retracted";
export type Visibility = "lineage" | "project" | "user";
export type Actor = "user" | "observer" | "import" | "system";
export type CoverageState = "pending" | "leased" | "processed" | "excluded" | "damaged";

export interface Scope {
  projectId: string;
  sessionId: string;
  entryIds: string[];
  includeUser?: boolean;
  environment?: string;
}

export interface SourceInput {
  entryId: string;
  parentId?: string | null;
  role: "user" | "assistant" | "toolResult" | "branch_summary" | "import";
  text: string;
  timestamp: string;
  hash?: string;
  tool?: string;
  target?: string;
  isError?: boolean;
  episodeId?: string;
}

export interface Source extends SourceInput {
  key: string;
  projectId: string;
  sessionId: string;
  hash: string;
  ordinal: number;
  erased: boolean;
}

export interface Evidence {
  sourceKey: string;
  hash: string;
  /** UTF-16 offsets into the stored, redacted source; never provider token offsets. */
  start: number;
  end: number;
}

export interface Dependency {
  id: string;
  revision: number;
}

export interface ClaimInput {
  id?: string;
  text: string;
  kind: ClaimKind;
  evidence: Evidence[];
  subject?: string;
  predicate?: string;
  value?: string;
  visibility?: Visibility;
  anchor?: string;
  conditions?: string[];
  cues?: string[];
  rationale?: string;
  alternatives?: string[];
  validFrom?: string;
  validUntil?: string;
  environment?: string;
  dependsOn?: Dependency[];
  status?: ClaimStatus;
  alias?: string;
}

export interface Claim extends ClaimInput {
  id: string;
  revision: number;
  projectId: string;
  sessionId: string;
  visibility: Visibility;
  anchor: string;
  status: ClaimStatus;
  actor: Actor;
  recordedAt: string;
  updatedAt: string;
  evidence: Evidence[];
  dependsOn: Dependency[];
  supersedes: string[];
  pinned: boolean;
  hidden: boolean;
  verification: "unverified" | "source_checked" | "outcome_checked";
  procedureState?: "candidate" | "trial_supported" | "promoted";
}

export interface SearchQuery {
  text?: string;
  scope: Scope;
  mode?: "current" | "history" | "all";
  limit?: number;
  asOf?: string;
  kinds?: ClaimKind[];
}

export interface SearchHit {
  claim: Claim;
  score: number;
  reasons: string[];
}
export interface Gap {
  sourceKey: string;
  entryId: string;
  start: number;
  end: number;
  state: CoverageState;
  reason?: string;
}
export interface Packet {
  text: string;
  manifest: {
    version: 2;
    epoch: number;
    hash: string;
    projectId: string;
    sessionId: string;
    claims: Dependency[];
    sourceKeys: string[];
    omitted: number;
    gaps: number;
    conflicts: number;
    budget: number;
    tokens: number;
    counter: string;
    valid: boolean;
    reasons: string[];
  };
}

export interface Job {
  id: string;
  owner: string;
  projectId: string;
  sessionId: string;
  chunks: Array<{ id: number; source: Source; start: number; end: number }>;
  reservedTokens: number;
  expiresAt: number;
}

export interface MemoryConfig {
  enabled: boolean;
  mode: "active" | "shadow" | "recall";
  contextTokens: number;
  summaryTokens: number;
  outputReserve: number;
  includeUser: boolean;
  observer: boolean;
  observerInputTokens: number;
  observerOutputTokens: number;
  dailyTokenBudget: number;
  jobTimeoutMs: number;
  maxAttempts: number;
  models: Array<{ provider: string; id: string }>;
  useSessionModel: boolean;
  excludedPaths: string[];
  redactionPatterns: string[];
  recallTokens: number;
  embeddings?: { endpoint: string; model: string; apiKeyEnv?: string; dimensions?: number };
}

export interface RecordResult {
  claim: Claim;
  duplicate: boolean;
  conflicts: string[];
}
export interface StoreStatus {
  epoch: number;
  claims: Record<string, number>;
  sources: number;
  gaps: Record<string, number>;
  budget: {
    day: string;
    spent: number;
    reserved: number;
    dollars: number;
    unknownCostCalls: number;
  };
}

export interface TrialInput {
  procedureId: string;
  expectedRevision: number;
  sourceKey: string;
  outcome: "success" | "failure";
  environment: string;
  note: string;
}

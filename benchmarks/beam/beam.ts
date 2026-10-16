/**
 * BEAM (Beyond a Million Tokens, arXiv:2510.27246) on Remendra v2.
 *
 * Each BEAM chat is ingested into its own Remendra store as one Pi session, the production
 * BackgroundLearner extracts memories from it with OBSERVER_PROMPT, and each probing question
 * is answered from what Remendra would put in front of the model. Answers are scored with
 * BEAM's own rubric judge prompt (unified_llm_judge_base_prompt), one call per rubric item.
 *
 * Conditions (all answered with BEAM's answer_generation_for_rag prompt):
 *   none    no memory at all (floor)
 *   bm25    BM25 over user/assistant pair chunks, same token budget as recall (RAG baseline)
 *   packet  the packet Remendra injects before the prompt (compile, contextTokens budget)
 *   recall  packet plus one recall call in source mode with the question as query
 *
 * Every LLM call is cached on disk by a hash of its request, so any stage can be resumed.
 * Run through benchmarks/beam/run.mjs, which bundles this file.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { MemoryService } from "../../src/v2/service.js";
import { BackgroundLearner, type Complete } from "../../src/v2/learner.js";
import type { MemoryClient } from "../../src/v2/client.js";
import { DEFAULT_CONFIG } from "../../src/v2/config.js";
import { clipTokens, estimateTokens } from "../../src/v2/text.js";
import type { Scope, SourceInput } from "../../src/v2/types.js";

// Verbatim from BEAM src/prompts.py.
const ANSWER_PROMPT = `
You are an assistant that MUST answer questions using ONLY the information provided in the context below.

STRICT INSTRUCTIONS:
1. Answer ONLY based on the provided context
2. Do NOT use your internal knowledge

CONTEXT:
<context>

QUESTION:
<question>

ANSWER REQUIREMENTS:
- Be direct and concise
- Only output the answer to the question without any explanation

RESPONSE:
`;

const JUDGE_PROMPT = `
You are an expert evaluator tasked with judging whether the LLM's response demonstrates compliance with the specified RUBRIC CRITERION.

## EVALUATION INPUTS
- RUBRIC CRITERION (what to check): <rubric_item>
- RESPONSE TO EVALUATE: <llm_response>

## EVALUATION RUBRIC:
The rubric defines a specific requirement, constraint, or expected behavior that the LLM response should demonstrate.

**IMPORTANT**: Pay careful attention to whether the rubric specifies:
- **Positive requirements** (things the response SHOULD include/do)
- **Negative constraints** (things the response SHOULD NOT include/do, often indicated by "no", "not", "avoid", "absent")

## RESPONSIVENESS REQUIREMENT
A compliant response must be **on-topic** and attempt to answer it.
- If the response does not address the QUESTION, score **0.0** and stop.
- For negative constraints, both must hold: (a) the response is responsive to the QUESTION, and (b) the prohibited element is absent.

## SEMANTIC TOLERANCE RULES:
Judge by meaning, not exact wording.
- Accept **paraphrases** and **synonyms** that preserve intent.
- **Case/punctuation/whitespace** differences must be ignored.
- **Numbers/currencies/dates** may appear in equivalent forms (e.g., “$68,000”, “68k”, “68,000 USD”, or “sixty-eight thousand dollars”). Treat them as equal when numerically equivalent.
- If the rubric expects a number or duration, prefer **normalized comparison** (extract and compare values) over string matching.

## STYLE NEUTRALITY (prevents style contamination):
Ignore tone, politeness, length, and flourish unless the rubric explicitly requires a format/structure (e.g., “itemized list”, “no citations”, “one sentence”).
- Do **not** penalize hedging, voice, or verbosity if content satisfies the rubric.
- Only evaluate format when the rubric **explicitly** mandates it.

## SCORING SCALE:
- **1.0 (Complete Compliance)**: Fully complies with the rubric criterion.
  - Positive: required element present, accurate, properly executed (allowing semantic equivalents).
  - Negative: prohibited element **absent** AND response is **responsive**.

- **0.5 (Partial Compliance)**: Partially complies.
  - Positive: element present but minor inaccuracies/incomplete execution.
  - Negative: generally responsive and mostly avoids the prohibited element but with minor/edge violations.

- **0.0 (No Compliance)**: Fails to comply.
  - Positive: required element missing or incorrect.
  - Negative: prohibited element present **or** response is non-responsive/evasive even if the element is absent.

## EVALUATION INSTRUCTIONS:
1. **Understand the Requirement**: Determine if the rubric is asking for something to be present (positive) or absent (negative/constraint).

2. **Parse Compound Statements**: If the rubric contains multiple elements connected by "and" or commas, evaluate whether:
   - **All elements** must be present for full compliance (1.0)
   - **Some elements** present indicates partial compliance (0.5)
   - **No elements** present indicates no compliance (0.0)

3. **Check Compliance**:
   - For positive requirements: Look for the presence and quality of the required element
   - For negative constraints: Look for the absence of the prohibited element

4. **Assign Score**: Based on compliance with the specific rubric criterion according to the scoring scale above.

5. **Provide Reasoning**: Explain whether the rubric criterion was satisfied and justify the score.

## OUTPUT FORMAT:
Return your evaluation in JSON format with two fields:

{
   "score": [your score: 1.0, 0.5, or 0.0],
   "reason": "[detailed explanation of whether the rubric criterion was satisfied and why this justified the assigned score]"
}

NOTE: ONLY output the json object, without any explanation before or after that
`;

const PLAIN_SYSTEM = "You are a helpful assistant.";
const CONDITIONS = ["none", "bm25", "packet", "recall"] as const;
type Condition = (typeof CONDITIONS)[number];

interface Options {
  beam: string;
  size: string;
  chats: number[];
  out: string;
  conditions: Condition[];
  stages: Set<string>;
  observerModel: string;
  answerModel: string;
  judgeModel: string;
  concurrency: number;
  contextTokens: number;
  recallTokens: number;
}

// ---------- LLM access: `claude -p` (default) or an OpenAI-compatible endpoint ----------

interface LlmResult {
  text: string;
  tokens: number;
  dollars?: number;
  ms: number;
  cached?: boolean;
}

let slots = 0;
const waiting: (() => void)[] = [];
async function limited<T>(limit: number, run: () => Promise<T>): Promise<T> {
  while (slots >= limit) await new Promise<void>((r) => waiting.push(r));
  slots++;
  try {
    return await run();
  } finally {
    slots--;
    waiting.shift()?.();
  }
}

function claudeCli(model: string, system: string, input: string): Promise<LlmResult> {
  const started = performance.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.env.BEAM_CLAUDE_BIN ?? "claude",
      [
        "-p",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--tools",
        "",
        "--model",
        model,
        "--output-format",
        "json",
        "--system-prompt",
        system,
      ],
      { cwd: tmpdir(), env: { ...process.env, MAX_THINKING_TOKENS: "0" } },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const out = JSON.parse(stdout) as {
          result?: string;
          is_error?: boolean;
          total_cost_usd?: number;
          usage?: Record<string, number>;
        };
        if (out.is_error || typeof out.result !== "string")
          throw new Error(out.result ?? "claude returned no result");
        const u = out.usage ?? {};
        resolvePromise({
          text: out.result,
          tokens:
            (u.input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.output_tokens ?? 0),
          dollars: out.total_cost_usd,
          ms: performance.now() - started,
        });
      } catch (error) {
        reject(
          new Error(
            `claude -p failed: ${error instanceof Error ? error.message : String(error)} ${stderr.slice(0, 300)}`,
          ),
        );
      }
    });
    child.stdin.end(input);
  });
}

async function openAiCompatible(model: string, system: string, input: string): Promise<LlmResult> {
  const started = performance.now();
  const response = await fetch(`${process.env.BEAM_OPENAI_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.BEAM_OPENAI_KEY ?? ""}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: input },
      ],
    }),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const body = (await response.json()) as {
    choices: { message: { content: string } }[];
    usage?: { total_tokens?: number };
  };
  return {
    text: body.choices[0]?.message.content ?? "",
    tokens: body.usage?.total_tokens ?? 0,
    ms: performance.now() - started,
  };
}

function makeLlm(opts: Options) {
  const cacheDir = join(opts.out, "llm-cache");
  mkdirSync(cacheDir, { recursive: true });
  return async (model: string, system: string, input: string): Promise<LlmResult> => {
    const key = createHash("sha256")
      .update(JSON.stringify([model, system, input]))
      .digest("hex");
    const file = join(cacheDir, `${key}.json`);
    if (existsSync(file))
      return { ...(JSON.parse(readFileSync(file, "utf8")) as LlmResult), cached: true };
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const result = await limited(opts.concurrency, () =>
          process.env.BEAM_OPENAI_URL
            ? openAiCompatible(model, system, input)
            : claudeCli(model, system, input),
        );
        writeFileSync(file, JSON.stringify(result));
        return result;
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}

// ---------- BEAM data ----------

interface Message {
  role: "user" | "assistant";
  id: number;
  content: string;
  time_anchor?: string;
}
interface Batch {
  batch_number: number;
  time_anchor?: string;
  turns: Message[][];
}
interface Question {
  category: string;
  index: number;
  question: string;
  rubric: string[];
  evidence: number[];
}

const MONTHS =
  "january february march april may june july august september october november december".split(
    " ",
  );
function anchorDate(anchor: string | undefined): Date | undefined {
  const m = /^([A-Za-z]+)-(\d{1,2})-(\d{4})$/.exec(anchor?.trim() ?? "");
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return m && month >= 0 ? new Date(Date.UTC(Number(m[3]), month, Number(m[2]), 9)) : undefined;
}

function loadChat(opts: Options, chat: number): { messages: (Message & { at: string })[] } {
  const batches = JSON.parse(
    readFileSync(join(opts.beam, "chats", opts.size, String(chat), "chat.json"), "utf8"),
  ) as Batch[];
  const messages: (Message & { at: string })[] = [];
  let clock = Date.UTC(2024, 0, 1, 9);
  for (const batch of batches) {
    const start = anchorDate(batch.time_anchor);
    if (start && start.getTime() > clock) clock = start.getTime();
    for (const turn of batch.turns)
      for (const message of turn) {
        const anchor = anchorDate(message.time_anchor);
        if (anchor && anchor.getTime() > clock) clock = anchor.getTime();
        clock += 60_000; // one minute per message keeps the order strict
        messages.push({ ...message, at: new Date(clock).toISOString() });
      }
  }
  return { messages };
}

function numbers(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(numbers);
  if (value && typeof value === "object") return Object.values(value).flatMap(numbers);
  return [];
}

function loadQuestions(opts: Options, chat: number): Question[] {
  const raw = JSON.parse(
    readFileSync(
      join(
        opts.beam,
        "chats",
        opts.size,
        String(chat),
        "probing_questions",
        "probing_questions.json",
      ),
      "utf8",
    ),
  ) as Record<string, Record<string, unknown>[]>;
  return Object.entries(raw).flatMap(([category, list]) =>
    list.map((q, index) => ({
      category,
      index,
      question: String(q.question),
      rubric: (q.rubric as string[] | undefined) ?? [],
      evidence: [...new Set(numbers(q.source_chat_ids))],
    })),
  );
}

// ---------- Remendra store per chat ----------

function openStore(opts: Options, chat: number) {
  const directory = join(opts.out, "chats", opts.size, String(chat));
  mkdirSync(directory, { recursive: true });
  const service = new MemoryService(join(directory, "memory.sqlite"), directory);
  service.configSet({
    ...DEFAULT_CONFIG,
    contextTokens: opts.contextTokens,
    recallTokens: opts.recallTokens,
    // A whole BEAM chat arrives at once: lift the 80k/day learning budget so it is all read.
    dailyTokenBudget: 10_000_000,
    jobTimeoutMs: 120_000,
  });
  const projectId = service.project(`/beam/${opts.size}/${chat}`);
  return { service, directory, projectId };
}

async function learn(opts: Options, chat: number, llm: ReturnType<typeof makeLlm>) {
  const { service, directory, projectId } = openStore(opts, chat);
  const marker = join(directory, "learned.json");
  if (existsSync(marker)) {
    service.close();
    return JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
  }
  const { messages } = loadChat(opts, chat);
  const sources: SourceInput[] = messages.map((m, i) => ({
    entryId: `m${i}`,
    parentId: i ? `m${i - 1}` : null,
    role: m.role,
    text: m.content,
    timestamp: m.at,
  }));
  const scope: Scope = { projectId, sessionId: "beam", entryIds: sources.map((s) => s.entryId) };
  service.ingest(scope, sources);
  const client = {
    call: (method: string, args: unknown[]) =>
      Promise.resolve(
        (service as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args),
      ),
  } as unknown as MemoryClient;
  const learner = new BackgroundLearner(client);
  let calls = 0,
    tokens = 0,
    dollars = 0,
    failures = 0;
  const complete: Complete = async (request) => {
    calls++;
    const result = await llm(opts.observerModel, request.system, request.input);
    tokens += result.tokens;
    dollars += result.dollars ?? 0;
    return { text: result.text, tokens: result.tokens, dollars: result.dollars };
  };
  const started = performance.now();
  // Each run is what one settled Pi turn does (at most 4 batches). Drain the whole chat.
  for (let run = 0, idle = 0; run < 2000 && idle < 3; run++) {
    const outcome = await learner.run(scope, service.config, complete, () => true);
    if (outcome.startsWith("Learning deferred")) failures++;
    const pending = service.status(scope).gaps.pending ?? 0;
    if (!pending) break;
    if (outcome.startsWith("No eligible work")) {
      idle++;
      await new Promise((r) => setTimeout(r, 31_000)); // failed chunks wait 30 s to retry
    } else idle = 0;
  }
  const status = service.status(scope);
  const stats = {
    chat,
    messages: messages.length,
    sourceTokens: sources.reduce((n, s) => n + estimateTokens(s.text), 0),
    claims: status.claims,
    chunks: status.gaps,
    observerCalls: calls,
    observerTokens: tokens,
    observerDollars: dollars,
    deferredRuns: failures,
    learnSeconds: Math.round((performance.now() - started) / 1000),
  };
  writeFileSync(join(directory, "scope.json"), JSON.stringify(scope));
  writeFileSync(marker, JSON.stringify(stats, null, 2));
  service.close();
  return stats;
}

// ---------- Retrieval ----------

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

class Bm25 {
  private docs: { terms: Map<string, number>; length: number }[] = [];
  private df = new Map<string, number>();
  private avg = 0;
  constructor(texts: string[]) {
    for (const text of texts) {
      const terms = new Map<string, number>();
      const words = tokenize(text);
      for (const w of words) terms.set(w, (terms.get(w) ?? 0) + 1);
      for (const w of terms.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      this.docs.push({ terms, length: words.length });
    }
    this.avg = this.docs.reduce((n, d) => n + d.length, 0) / Math.max(1, this.docs.length);
  }
  rank(query: string): number[] {
    const q = [...new Set(tokenize(query))];
    const n = this.docs.length;
    const scores = this.docs.map((d) =>
      q.reduce((s, w) => {
        const f = d.terms.get(w);
        if (!f) return s;
        const idf = Math.log(1 + (n - (this.df.get(w) ?? 0) + 0.5) / ((this.df.get(w) ?? 0) + 0.5));
        return s + (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.length) / this.avg));
      }, 0),
    );
    return scores
      .map((s, i) => [s, i] as const)
      .filter(([s]) => s > 0)
      .sort((a, b) => b[0] - a[0])
      .map(([, i]) => i);
  }
}

interface Context {
  text: string;
  messageIds: Set<number>;
  tokens: number;
  ms: number;
}

async function contexts(opts: Options, chat: number, questions: Question[]) {
  const { service, directory } = openStore(opts, chat);
  const scope = JSON.parse(readFileSync(join(directory, "scope.json"), "utf8")) as Scope;
  const { messages } = loadChat(opts, chat);
  const entryToMessage = (entryId: string) => messages[Number(entryId.slice(1))]?.id;
  // BEAM's RAG baseline unit: a user message with the assistant reply that follows it.
  const pairs: { text: string; ids: number[] }[] = [];
  for (const m of messages) {
    const last = pairs.at(-1);
    if (m.role === "assistant" && last && last.ids.length === 1) {
      last.text += `\nassistant: ${m.content}`;
      last.ids.push(m.id);
    } else pairs.push({ text: `${m.role}: ${m.content}`, ids: [m.id] });
  }
  const bm25 = new Bm25(pairs.map((p) => p.text));
  const out = new Map<string, Context>();
  for (const q of questions) {
    for (const condition of opts.conditions) {
      const started = performance.now();
      let text = "";
      const ids = new Set<number>();
      if (condition === "bm25") {
        let used = 0;
        const budget = opts.contextTokens + opts.recallTokens;
        const parts: string[] = [];
        for (const i of bm25.rank(q.question)) {
          const t = estimateTokens(pairs[i].text);
          if (used + t > budget) continue;
          used += t;
          parts.push(pairs[i].text);
          pairs[i].ids.forEach((id) => ids.add(id));
          if (used > budget - 50) break;
        }
        text = parts.join("\n\n---\n\n");
      } else if (condition === "packet" || condition === "recall") {
        const packet = service.compile(scope, q.question, opts.contextTokens);
        text = packet.text;
        for (const dep of packet.manifest.claims) {
          const claim = service.store.claim(dep.id, scope, true);
          for (const e of claim?.evidence ?? []) {
            const source = service.store.source(e.sourceKey);
            const id = source && entryToMessage(source.entryId);
            if (id !== undefined) ids.add(id);
          }
        }
        if (condition === "recall") {
          const recalled = service.recall(scope, { query: q.question, mode: "source" });
          for (const m of recalled.matchAll(/"entry":"(m\d+)"/g)) {
            const id = entryToMessage(m[1]);
            if (id !== undefined) ids.add(id);
          }
          text += `\n\nrecall({"query": ${JSON.stringify(q.question)}, "mode": "source"}):\n${recalled}`;
        }
      }
      out.set(`${q.category}/${q.index}/${condition}`, {
        text: text || "(no context)",
        messageIds: ids,
        tokens: estimateTokens(text),
        ms: performance.now() - started,
      });
    }
  }
  service.close();
  return out;
}

// ---------- Judge ----------

function judgeScore(text: string): number | undefined {
  const match = /"score"\s*:\s*\[?\s*([01](?:\.\d+)?)/.exec(text);
  return match ? Number(match[1]) : undefined;
}

// ---------- Main ----------

function parseRange(text: string): number[] {
  return text.split(",").flatMap((part) => {
    const [a, b] = part.split("-").map(Number);
    return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      beam: { type: "string" },
      size: { type: "string", default: "100K" },
      chats: { type: "string" },
      out: { type: "string", default: "benchmarks/beam/results" },
      conditions: { type: "string", default: CONDITIONS.join(",") },
      stages: { type: "string", default: "learn,answer,judge,report" },
      "observer-model": { type: "string", default: "claude-haiku-5-5" },
      "answer-model": { type: "string", default: "claude-sonnet-5-5" },
      "judge-model": { type: "string", default: "claude-sonnet-5-5" },
      concurrency: { type: "string", default: "8" },
      "context-tokens": { type: "string", default: String(DEFAULT_CONFIG.contextTokens) },
      "recall-tokens": { type: "string", default: String(DEFAULT_CONFIG.recallTokens) },
      fresh: { type: "boolean", default: false },
    },
  });
  if (!values.beam) throw new Error("--beam <path to a BEAM checkout> is required");
  const beam = resolve(values.beam);
  const size = values.size!;
  const available = readdirSync(join(beam, "chats", size))
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .sort((a, b) => a - b);
  const opts: Options = {
    beam,
    size,
    chats: values.chats ? parseRange(values.chats) : available,
    out: resolve(values.out!),
    conditions: values.conditions!.split(",") as Condition[],
    stages: new Set(values.stages!.split(",")),
    observerModel: values["observer-model"]!,
    answerModel: values["answer-model"]!,
    judgeModel: values["judge-model"]!,
    concurrency: Number(values.concurrency),
    contextTokens: Number(values["context-tokens"]),
    recallTokens: Number(values["recall-tokens"]),
  };
  if (values.fresh) rmSync(join(opts.out, "chats", size), { recursive: true, force: true });
  const llm = makeLlm(opts);
  const log = (...parts: unknown[]) =>
    process.stderr.write(`[beam ${new Date().toISOString().slice(11, 19)}] ${parts.join(" ")}\n`);

  const learned: Record<string, unknown>[] = [];
  const rows: Record<string, unknown>[] = [];
  await Promise.all(
    opts.chats.map(async (chat) => {
      const stats = await learn(opts, chat, llm);
      learned.push(stats);
      log(
        `chat ${chat} learned`,
        JSON.stringify(stats.claims),
        `${String(stats.observerCalls)} calls`,
      );
      if (!opts.stages.has("answer")) return;
      const questions = loadQuestions(opts, chat);
      const ctx = await contexts(opts, chat, questions);
      await Promise.all(
        questions.flatMap((q) =>
          opts.conditions.map(async (condition) => {
            const c = ctx.get(`${q.category}/${q.index}/${condition}`)!;
            const prompt = ANSWER_PROMPT.replace("<context>", c.text).replace(
              "<question>",
              q.question,
            );
            const answer = await llm(opts.answerModel, PLAIN_SYSTEM, prompt);
            let score: number | undefined;
            const judged: { score?: number; reason: string }[] = [];
            if (opts.stages.has("judge") && q.rubric.length) {
              for (const item of q.rubric) {
                const verdict = await llm(
                  opts.judgeModel,
                  PLAIN_SYSTEM,
                  JUDGE_PROMPT.replace("<rubric_item>", item).replace(
                    "<llm_response>",
                    answer.text,
                  ),
                );
                judged.push({ score: judgeScore(verdict.text), reason: verdict.text });
              }
              const valid = judged.filter((j) => j.score !== undefined);
              score = valid.length
                ? valid.reduce((n, j) => n + j.score!, 0) / q.rubric.length
                : undefined;
            }
            const hit = q.evidence.filter((id) => c.messageIds.has(id)).length;
            rows.push({
              chat,
              category: q.category,
              index: q.index,
              condition,
              question: q.question,
              answer: answer.text,
              score,
              judged,
              evidence: q.evidence.length,
              evidenceHit: hit,
              contextTokens: c.tokens,
              retrievalMs: Math.round(c.ms * 10) / 10,
            });
          }),
        ),
      );
      log(`chat ${chat} answered`);
    }),
  );
  mkdirSync(opts.out, { recursive: true });
  const tag = `${size}`;
  learned.sort((a, b) => Number(a.chat) - Number(b.chat));
  writeFileSync(join(opts.out, `learn-${tag}.json`), JSON.stringify(learned, null, 2));
  if (rows.length) writeFileSync(join(opts.out, `rows-${tag}.json`), JSON.stringify(rows, null, 2));
  if (opts.stages.has("report") && rows.length)
    writeFileSync(join(opts.out, `report-${tag}.md`), report(opts, learned, rows));
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

function report(
  opts: Options,
  learned: Record<string, unknown>[],
  rows: Record<string, unknown>[],
) {
  const categories = [...new Set(rows.map((r) => String(r.category)))].sort();
  const pct = (n: number) => (Number.isNaN(n) ? "–" : (100 * n).toFixed(1));
  const lines = [
    `# BEAM ${opts.size} on Remendra`,
    "",
    `Chats ${opts.chats.length}, questions ${rows.length / opts.conditions.length}. Observer ${opts.observerModel}, answers ${opts.answerModel}, judge ${opts.judgeModel}. Packet budget ${opts.contextTokens} tokens, recall budget ${opts.recallTokens}.`,
    "",
    "## Judge score (%) by ability",
    "",
    `| Ability | ${opts.conditions.join(" | ")} |`,
    `|---|${opts.conditions.map(() => "---:").join("|")}|`,
  ];
  const scored = (c: string, cat?: string) =>
    rows
      .filter(
        (r) => r.condition === c && (!cat || r.category === cat) && typeof r.score === "number",
      )
      .map((r) => Number(r.score));
  for (const cat of categories)
    lines.push(`| ${cat} | ${opts.conditions.map((c) => pct(mean(scored(c, cat)))).join(" | ")} |`);
  lines.push(
    `| **mean of abilities** | ${opts.conditions
      .map((c) => `**${pct(mean(categories.map((cat) => mean(scored(c, cat)))))}**`)
      .join(" | ")} |`,
  );
  lines.push("", "## Evidence in context", "");
  lines.push(
    "Share of questions with labelled evidence where at least one / every evidence message is cited by the context.",
    "",
    `| Condition | any evidence | all evidence | mean context tokens | mean retrieval ms |`,
    "|---|---:|---:|---:|---:|",
  );
  for (const c of opts.conditions) {
    const r = rows.filter((x) => x.condition === c);
    const withEvidence = r.filter((x) => Number(x.evidence) > 0);
    lines.push(
      `| ${c} | ${pct(mean(withEvidence.map((x) => (Number(x.evidenceHit) > 0 ? 1 : 0))))} | ${pct(
        mean(withEvidence.map((x) => (x.evidenceHit === x.evidence ? 1 : 0))),
      )} | ${mean(r.map((x) => Number(x.contextTokens))).toFixed(0)} | ${mean(
        r.map((x) => Number(x.retrievalMs)),
      ).toFixed(1)} |`,
    );
  }
  const sum = (k: string) => learned.reduce((n, l) => n + Number(l[k] ?? 0), 0);
  const claims = learned.reduce(
    (n, l) =>
      n + Object.values((l.claims ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0),
    0,
  );
  lines.push(
    "",
    "## Learning",
    "",
    `Source tokens ${sum("sourceTokens")}, observer calls ${sum("observerCalls")}, observer tokens ${sum("observerTokens")}, observer cost $${sum("observerDollars").toFixed(2)}, memories ${claims}, deferred runs ${sum("deferredRuns")}.`,
    "",
  );
  return lines.join("\n");
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});

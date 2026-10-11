// Executes the built package through Pi's real resource loader, SDK and fake provider.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { DatabaseSync } from "node:sqlite";

const background = process.argv.includes("--observer");
const entry = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "dist/index.js",
);

const directory = mkdtempSync(join(tmpdir(), "remendra-sdk-"));
const previousHome = process.env.PI_REMENDRA_HOME;
process.env.PI_REMENDRA_HOME = join(directory, "memory");
mkdirSync(process.env.PI_REMENDRA_HOME, { recursive: true });
writeFileSync(
  join(process.env.PI_REMENDRA_HOME, "config.json"),
  JSON.stringify({ observer: background }),
);
let session;
try {
  let calls = 0,
    backgroundCalls = 0,
    cueCalls = 0,
    lastContext;
  const provider = "remendra-test",
    api = "remendra-test-api";
  const definition = {
    id: "fixture",
    name: "Deterministic fixture",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 2048,
  };
  const model = { ...definition, provider, api, baseUrl: "http://127.0.0.1:1" };
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  settings.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: join(directory, "agent"),
    settingsManager: settings,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalExtensionPaths: [entry],
    extensionFactories: [
      (pi) => {
        pi.registerProvider(provider, {
          api,
          baseUrl: model.baseUrl,
          apiKey: "local-test",
          models: [definition],
          streamSimple: (_model, context) => {
            // Pi 1.x hands providers the system prompt as a "system" message (normalizeContext);
            // older versions used context.systemPrompt. Accept both.
            const textOf = (c) =>
              typeof c === "string"
                ? c
                : Array.isArray(c)
                  ? c.map((b) => b.text ?? "").join("")
                  : "";
            const systemText = [
              context.systemPrompt ?? "",
              ...context.messages
                .filter((m) => m.role === "system")
                .map((m) => textOf(m.content) + JSON.stringify(m.sections ?? {})),
            ].join("\n");
            const observing = systemText.includes("Extract useful durable memories");
            const cueing = systemText.includes("For each memory, write");
            let text = "Use PostgreSQL.";
            if (cueing) {
              // Background cue backfill for memories saved without cues.
              cueCalls++;
              const input = context.messages.find((m) => m.role === "user");
              const { memories } = JSON.parse(textOf(input.content));
              text = JSON.stringify({ cues: memories.map(() => ["database engine", "storage"]) });
            } else if (observing) {
              backgroundCalls++;
              const input = context.messages.find((m) => m.role === "user");
              const { chunks } = JSON.parse(textOf(input.content));
              const chunk = chunks[0];
              text = JSON.stringify({
                claims: chunk
                  ? [
                      {
                        text: chunk.text,
                        kind: "decision",
                        evidence: [{ chunk: chunk.chunk, quote: chunk.text }],
                      },
                    ]
                  : [],
              });
            } else {
              calls++;
              lastContext = context;
            }
            const stream = createAssistantMessageEventStream();
            const message = {
              role: "assistant",
              content: [{ type: "text", text }],
              api,
              provider,
              model: definition.id,
              usage: {
                input: 100,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 105,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            };
            queueMicrotask(() => {
              stream.push({ type: "done", reason: "stop", message });
              stream.end(message);
            });
            return stream;
          },
        });
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const created = await createAgentSession({
    cwd: directory,
    agentDir: join(directory, "agent"),
    resourceLoader: loader,
    model,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(directory),
    noTools: "builtin",
  });
  session = created.session;
  const errors = [];
  session.subscribe((event) => {
    if (event.type === "extension_error") errors.push(event);
  });
  await session.prompt(
    '/remendra remember {"text":"Use PostgreSQL for the project database","kind":"decision"}',
  );
  await session.prompt("Which database should this project use?");
  assert.equal(calls, 1, "Only the foreground fixture provider should run");
  assert.ok(
    JSON.stringify(lastContext.messages).includes("Use PostgreSQL for the project database"),
    "The real provider must receive the memory packet",
  );
  assert.ok(
    JSON.stringify(lastContext.messages).includes("source_checked"),
    "The packet must retain evidence status",
  );
  assert.deepEqual(errors, []);
  if (background) {
    const db = new DatabaseSync(join(process.env.PI_REMENDRA_HOME, "memory.sqlite"));
    try {
      const deadline = Date.now() + 3000;
      let spent = 0;
      while (Date.now() < deadline) {
        spent = Number(
          db.prepare("SELECT COALESCE(SUM(spent),0) AS spent FROM budgets").get().spent,
        );
        if (spent > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(backgroundCalls > 0, "The observer must use Pi's native custom-provider dispatch");
      // Wait for the cue backfill that follows learning, then check both were charged once.
      const until = Date.now() + 3000;
      while (Date.now() < until && spent < 210) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        spent = Number(
          db.prepare("SELECT COALESCE(SUM(spent),0) AS spent FROM budgets").get().spent,
        );
      }
      assert.equal(cueCalls, 1, "The remembered memory must get its search cues once");
      assert.equal(spent, 210, "Observer and cue usage must commit through the memory worker");
      const cued = db
        .prepare("SELECT data FROM claims WHERE text LIKE '%PostgreSQL%'")
        .all()
        .some((row) => JSON.parse(row.data).cues?.includes("database engine"));
      assert.ok(cued, "Cues must be stored on the memory");
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      db.close();
    }
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        pi: JSON.parse(
          readFileSync(
            new URL(
              "../node_modules/@earendil-works/pi-coding-agent/package.json",
              import.meta.url,
            ),
            "utf8",
          ),
        ).version,
        node: process.version,
        providerCalls: calls,
        backgroundProviderCalls: backgroundCalls,
        cueCalls,
        extensionErrors: errors.length,
        entry,
      },
      null,
      2,
    ),
  );
} finally {
  session?.dispose();
  if (previousHome === undefined) delete process.env.PI_REMENDRA_HOME;
  else process.env.PI_REMENDRA_HOME = previousHome;
  rmSync(directory, { recursive: true, force: true });
}

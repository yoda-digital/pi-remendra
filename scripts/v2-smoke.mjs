// Executes the built package through Pi's real resource loader, SDK and fake provider.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
            const observing = context.systemPrompt?.startsWith("Extract useful durable memories");
            let text = "Use PostgreSQL.";
            if (observing) {
              backgroundCalls++;
              const { chunks } = JSON.parse(context.messages[0].content);
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
      assert.equal(spent, 105, "Observer usage must commit through the memory worker");
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      db.close();
    }
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        pi: "0.85.1",
        node: process.version,
        providerCalls: calls,
        backgroundProviderCalls: backgroundCalls,
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

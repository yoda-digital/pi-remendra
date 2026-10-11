import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryClient } from "../../src/v2/client.js";
import { installV2, LEARN_DELAY_MS } from "../../src/v2/extension.js";
import { PACKET_TYPE } from "../../src/v2/compiler.js";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

let directory: string, client: MemoryClient, ctx: ExtensionContext;
const hooks = new Map<string, Function>();
const commands = new Map<string, Function>();
const registeredTools = new Map<string, Record<string, unknown>>();
let entries: SessionEntry[], output: unknown[], sid: string;
const previousHome = process.env.PI_REMENDRA_HOME;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "remendra-extension-"));
  // Keep the extension's own files (log, first-run marker) out of the real ~/.pi data folder.
  process.env.PI_REMENDRA_HOME = directory;
  client = new MemoryClient(
    join(directory, "memory.sqlite"),
    directory,
    pathToFileURL(resolve("dist/v2/worker.js")),
  );
  hooks.clear();
  commands.clear();
  registeredTools.clear();
  output = [];
  sid = "session";
  entries = [
    {
      id: "user-1",
      type: "message",
      parentId: null,
      timestamp: "2026-09-06T00:00:00Z",
      message: { role: "user", content: "Use PostgreSQL", timestamp: Date.now() },
    },
  ];
  const pi = {
    on: (event: string, handler: Function) => hooks.set(event, handler),
    registerCommand: (name: string, value: { handler: Function }) =>
      commands.set(name, value.handler),
    registerTool: (tool: Record<string, unknown>) => registeredTools.set(String(tool.name), tool),
    appendEntry: (customType: string, data: unknown) =>
      entries.push({
        type: "custom",
        id: `custom-${entries.length}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      }),
    sendMessage: (message: unknown) => output.push(message),
  };
  ctx = {
    cwd: directory,
    hasUI: true,
    mode: "tui",
    isIdle: () => true,
    isProjectTrusted: () => true,
    model: { provider: "fake", id: "fake", contextWindow: 128000 },
    modelRegistry: { find: () => undefined, complete: vi.fn() },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 128000, percent: 1 }),
    sessionManager: {
      getBranch: () => [...entries],
      getSessionId: () => sid,
      getSessionFile: () => undefined,
      getLeafId: () => entries.at(-1)?.id,
    },
    ui: { notify: (message: unknown) => output.push(message), setStatus: () => {} },
  } as unknown as ExtensionContext;
  installV2(pi as unknown as ExtensionAPI, client);
  await hooks.get("session_start")!({}, ctx);
});
afterEach(async () => {
  await hooks.get("session_shutdown")!({}, ctx);
  if (previousHome === undefined) delete process.env.PI_REMENDRA_HOME;
  else process.env.PI_REMENDRA_HOME = previousHome;
  rmSync(directory, { recursive: true, force: true });
});

it("registers native lifecycle handlers, the recall tool, and compatibility commands", () => {
  expect([...registeredTools.keys()]).toEqual(["recall"]);
  expect(commands.has("remendra")).toBe(true);
  expect(commands.has("remendra-memory")).toBe(true);
  expect(hooks.has("agent_settled")).toBe(true);
});
it("records an explicit user memory with verified evidence and injects it once", async () => {
  await commands.get("remendra")!(
    'remember {"text":"Preserve production data","kind":"constraint"}',
    ctx,
  );
  expect(output.at(-1)).not.toContain("Remendra:");
  const event = { messages: [{ role: "user", content: "Continue", timestamp: Date.now() }] };
  const first = await hooks.get("context")!(event, ctx);
  expect(first.messages[0].customType).toBe(PACKET_TYPE);
  expect(first.messages[0].content).toContain("Preserve production data");
  const second = await hooks.get("context")!({ messages: first.messages }, ctx);
  expect(
    second.messages.filter((m: { customType?: string }) => m.customType === PACKET_TYPE),
  ).toHaveLength(1);
});
it("does not split tool calls from results or modify their contents", async () => {
  const pair = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "true" } }],
    },
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "bash",
      content: [{ type: "text", text: "done" }],
      isError: false,
    },
  ];
  const result = await hooks.get("context")!({ messages: pair }, ctx);
  expect(result.messages.slice(-2)).toEqual(pair);
});
it("removes obsolete memory after correction and on branch switch", async () => {
  await commands.get("remendra")!('remember {"text":"Use SQLite","kind":"decision"}', ctx);
  const record = JSON.parse(String(output.at(-1)));
  await commands.get("remendra")!(`correct ${record.id} Use PostgreSQL instead`, ctx);
  const result = await hooks.get("context")!({ messages: [] }, ctx);
  expect(result.messages[0].content).toContain("Use PostgreSQL instead");
  expect(result.messages[0].content).not.toContain('"text":"Use SQLite"');
  // Corrected claim is now project-scoped (auto-promoted via user correction).
  // On branch switch, project-scoped claims remain visible.
  entries = entries.slice(0, 1);
  await hooks.get("session_tree")!({}, ctx);
  const switched = await hooks.get("context")!({ messages: result.messages }, ctx);
  expect(switched.messages[0].content).toContain("Use PostgreSQL instead");
  expect(switched.messages[0].content).not.toContain('"text":"Use SQLite"');
});
it("compiles in shadow mode without injecting", async () => {
  await commands.get("remendra")!('settings {"mode":"shadow"}', ctx);
  const messages = [{ role: "user", content: "Hi" }];
  expect((await hooks.get("context")!({ messages }, ctx)).messages).toEqual(messages);
});
it("drops its packet when context headroom is exhausted", async () => {
  ctx.getContextUsage = () => ({ tokens: 127999, contextWindow: 128000, percent: 99 });
  expect((await hooks.get("context")!({ messages: [] }, ctx)).messages).toEqual([]);
});
it("leaves compaction scheduling and summary generation with native Pi", async () => {
  expect(await hooks.get("session_before_compact")!({}, ctx)).toBeUndefined();
  await hooks.get("session_compact")!({}, ctx);
  expect(entries.at(-1)?.type).toBe("custom");
});
it("preserves authoritative user and tool messages if storage fails", async () => {
  await client.close();
  const messages = [
    { role: "user", content: "Keep this request" },
    { role: "custom", customType: PACKET_TYPE, content: "Old memory" },
    { role: "custom", customType: "remendra.v2.context", content: "Legacy packet" },
    { role: "custom", customType: "remendra.v2.output", content: "Legacy output" },
  ];
  const result = await hooks.get("context")!({ messages }, ctx);
  // H2: On failure, a diagnostic note is prepended before the clean messages
  expect(result.messages.length).toBe(2);
  expect(result.messages[0].customType).toBe(PACKET_TYPE);
  expect(result.messages[0].content).toContain("unavailable");
  expect(result.messages[1]).toEqual(messages[0]);
});
it("user /remember creates project-scoped memories visible across sessions", async () => {
  await commands.get("remendra")!("remember Cross-session decision", ctx);
  sid = "second-session";
  await hooks.get("session_start")!({}, ctx);
  const result = await hooks.get("context")!({ messages: [] }, ctx);
  // User-created memories default to project scope (auto-promotion)
  expect(result.messages[0].content).toContain("Cross-session decision");
});
it("places the memory packet right before the latest user prompt, keeping earlier turns cache-stable", async () => {
  await commands.get("remendra")!(
    'remember {"text":"Preserve production data","kind":"constraint"}',
    ctx,
  );
  const history = [
    { role: "user", content: "First question", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "First answer" }], timestamp: 2 },
    { role: "user", content: "Second question about production data", timestamp: 3 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "true" } }],
      timestamp: 4,
    },
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 5,
    },
  ];
  const result = await hooks.get("context")!({ messages: history }, ctx);
  const roles = result.messages.map(
    (m: { role: string; customType?: string }) => m.customType ?? m.role,
  );
  expect(roles).toEqual(["user", "assistant", PACKET_TYPE, "user", "assistant", "toolResult"]);
  expect(result.messages.slice(0, 2)).toEqual(history.slice(0, 2));
  expect(result.messages.slice(-2)).toEqual(history.slice(-2));
});
it("a session that ends right after settling (pi -p) never starts learning", async () => {
  const calls = vi.spyOn(client, "call");
  await hooks.get("agent_settled")!({}, ctx);
  await hooks.get("session_shutdown")!({}, ctx);
  await new Promise((r) => setTimeout(r, LEARN_DELAY_MS + 300));
  expect(calls.mock.calls.some(([method]) => method === "lease")).toBe(false);
  calls.mockRestore();
});
it("a long-lived session starts learning shortly after settling", async () => {
  const calls = vi.spyOn(client, "call");
  await hooks.get("agent_settled")!({}, ctx);
  expect(calls.mock.calls.some(([method]) => method === "lease")).toBe(false);
  await new Promise((r) => setTimeout(r, LEARN_DELAY_MS + 500));
  expect(calls.mock.calls.some(([method]) => method === "lease")).toBe(true);
  calls.mockRestore();
});
it("tells the user why nothing is learned in an untrusted project", async () => {
  const statuses: string[] = [];
  const untrusted = {
    ...ctx,
    isProjectTrusted: () => false,
    ui: { ...ctx.ui, setStatus: (_key: string, text: string) => statuses.push(text) },
  } as unknown as ExtensionContext;
  await commands.get("remendra")!("learn", untrusted);
  expect(String(output.at(-1))).toContain("not trusted");
  expect(statuses.at(-1)).toContain("not trusted");
});
it("follows Pi context edits: removed or rewritten messages stop feeding memory", async () => {
  const { realpath } = await import("node:fs/promises");
  const projectId = await client.call("project", [await realpath(directory)]);
  const sourceHits = async (query: string) =>
    String(
      await client.call("recall", [
        { projectId, sessionId: sid, entryIds: entries.map((e) => e.id) },
        { query, mode: "source" },
      ]),
    );
  expect(await sourceHits("PostgreSQL")).toContain("PostgreSQL");

  entries.push({
    type: "context_edit",
    id: "edit-1",
    parentId: "user-1",
    timestamp: "2026-09-06T00:01:00Z",
    targetId: "user-1",
    replacement: { content: "Use SQLite for local development" },
  } as never);
  await hooks.get("turn_end")!({}, ctx);
  expect(await sourceHits("PostgreSQL")).not.toContain("Use PostgreSQL");
  expect(await sourceHits("SQLite")).toContain("SQLite");

  entries.push({
    type: "context_edit",
    id: "edit-2",
    parentId: "edit-1",
    timestamp: "2026-09-06T00:02:00Z",
    targetId: "user-1",
    replacement: null,
  } as never);
  await hooks.get("turn_end")!({}, ctx);
  expect(await sourceHits("SQLite")).not.toContain("Use SQLite");
});

it("keeps an unchanged packet where it was, so the previous turn keeps its cache", async () => {
  await commands.get("remendra")!(
    'remember {"text":"Preserve production data","kind":"constraint"}',
    ctx,
  );
  const turn1 = [
    { role: "user", content: "First question", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "First answer" }], timestamp: 2 },
  ];
  const first = await hooks.get("context")!({ messages: turn1 }, ctx);
  const turn2 = [
    ...turn1,
    { role: "user", content: "Second question", timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "Second answer" }], timestamp: 4 },
  ];
  const second = await hooks.get("context")!({ messages: turn2 }, ctx);
  const kinds = (r: { messages: { role: string; customType?: string }[] }) =>
    r.messages.map((m) => m.customType ?? m.role);
  expect(kinds(second)).toEqual([PACKET_TYPE, "user", "assistant", "user", "assistant"]);
  // Byte for byte the same message as the first request: the provider cache still matches.
  expect(second.messages[0]).toBe(first.messages[0]);
  // A new memory changes the packet, which then moves to the latest prompt.
  await commands.get("remendra")!('remember {"text":"Backups run nightly","kind":"fact"}', ctx);
  const third = await hooks.get("context")!({ messages: turn2 }, ctx);
  expect(kinds(third)).toEqual(["user", "assistant", PACKET_TYPE, "user", "assistant"]);
});

it("falls back to semantic search in the recall tool when no memory matches the words", async () => {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { input } = JSON.parse(body) as { input: string[] };
      const data = input.map((text, index) => ({
        index,
        embedding: /hetzner|cloud/i.test(text) ? [1, 0] : [0, 1],
      }));
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data, usage: { total_tokens: 5 } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const { port } = server.address() as { port: number };
    const endpoint = `http://127.0.0.1:${port}/embeddings`;
    await commands.get("remendra")!(
      `settings {"embeddings":{"endpoint":"${endpoint}","model":"t"}}`,
      ctx,
    );
    await commands.get("remendra")!(
      'remember {"text":"The API is deployed to Hetzner fsn1","kind":"fact"}',
      ctx,
    );
    await commands.get("remendra")!('remember {"text":"Backups run nightly","kind":"fact"}', ctx);
    await commands.get("remendra")!("embed", ctx);
    const recall = registeredTools.get("recall")!.execute as Function;
    const result = await recall(
      "id",
      { query: "which cloud hosts the backend" },
      undefined,
      undefined,
      ctx,
    );
    const text = result.content[0].text as string;
    expect(text).toMatch(/^Memory results 1 by meaning/);
    expect(text.split("\n")[1]).toContain("Hetzner fsn1");
    expect(text).toContain("similarity 1.00");
    // Words that match skip the fallback.
    const direct = await recall("id", { query: "backups" }, undefined, undefined, ctx);
    expect(direct.content[0].text).toMatch(/^Memory results 1;/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

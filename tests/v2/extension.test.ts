import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryClient } from "../../src/v2/client.js";
import { installV2 } from "../../src/v2/extension.js";
import { PACKET_TYPE } from "../../src/v2/compiler.js";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

let directory: string, client: MemoryClient, ctx: ExtensionContext;
const hooks = new Map<string, Function>();
const commands = new Map<string, Function>();
const registeredTools = new Map<string, Record<string, unknown>>();
let entries: SessionEntry[], output: unknown[], sid: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "remendra-extension-"));
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
  entries = entries.slice(0, 1);
  await hooks.get("session_tree")!({}, ctx);
  const switched = await hooks.get("context")!({ messages: result.messages }, ctx);
  expect(switched.messages[0].content).not.toContain("Use PostgreSQL instead");
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
    { role: "custom", customType: "blackhole.v2.context", content: "Legacy packet" },
    { role: "custom", customType: "blackhole.v2.output", content: "Legacy output" },
  ];
  const result = await hooks.get("context")!({ messages }, ctx);
  expect(result.messages).toEqual([messages[0]]);
});
it("does not share lineage memories with another session", async () => {
  await commands.get("remendra")!("remember Session-only decision", ctx);
  sid = "second-session";
  await hooks.get("session_start")!({}, ctx);
  const result = await hooks.get("context")!({ messages: [] }, ctx);
  expect(result.messages[0].content).not.toContain("Session-only decision");
});

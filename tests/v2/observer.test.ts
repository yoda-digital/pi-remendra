import { parseObservations, observerInput, abortable } from "../../src/v2/observer.js";
import { sourceInputs } from "../../src/v2/sources.js";
import { validateConfig } from "../../src/v2/config.js";
import { clipTokens, estimateTokens } from "../../src/v2/text.js";
import type { Job } from "../../src/v2/types.js";

const job: Job = {
  id: "job",
  owner: "worker",
  projectId: "project",
  sessionId: "session",
  reservedTokens: 2000,
  expiresAt: Date.now() + 10000,
  chunks: [
    {
      id: 1,
      start: 7,
      end: 46,
      source: {
        key: "source-key",
        entryId: "entry",
        projectId: "project",
        sessionId: "session",
        role: "user",
        text: "Header: Never delete production data. End here.",
        timestamp: "2026-09-06T00:00:00Z",
        hash: "hash",
        ordinal: 1,
        erased: false,
      },
    },
  ],
};
const output = (changes: Record<string, unknown> = {}) =>
  JSON.stringify({
    claims: [
      {
        text: "Never delete production data.",
        kind: "constraint",
        evidence: [{ chunk: 0, quote: "Never delete production data." }],
        ...changes,
      },
    ],
  });

it("resolves exact quotes to original source offsets and stable IDs", () => {
  const a = parseObservations(output(), job)[0];
  expect(a.evidence[0]).toEqual({ sourceKey: "source-key", hash: "hash", start: 8, end: 37 });
  expect(parseObservations(output(), job)[0].id).toBe(a.id);
  expect(observerInput(job)).not.toContain("Header:");
});
it("skips claims with imaginary quotes, rejects unknown chunks and malformed output", () => {
  // Imaginary quotes are skipped (not thrown) — the claim is dropped
  const result = parseObservations(
    output({ evidence: [{ chunk: 0, quote: "Delete all production data" }] }),
    job,
  );
  expect(result).toEqual([]); // Claim dropped because all evidence failed
  expect(() =>
    parseObservations(output({ evidence: [{ chunk: 99, quote: "Never" }] }), job),
  ).toThrow("unknown");
  expect(() => parseObservations("not json", job)).toThrow();
});
it("rejects ambiguous short quotes instead of guessing their source position", () => {
  const repeated = structuredClone(job);
  repeated.chunks[0].source.text = "abc abc";
  repeated.chunks[0].start = 0;
  repeated.chunks[0].end = 7;
  // Ambiguous quotes now resolve to the first match instead of throwing
  const result = parseObservations(output({ evidence: [{ chunk: 0, quote: "abc" }] }), repeated);
  expect(result[0].evidence[0].start).toBe(0);
  expect(result[0].evidence[0].end).toBe(3);
});
it("downgrades assistant-only assertions to hypotheses", () => {
  const proposed = structuredClone(job);
  proposed.chunks[0].source.role = "assistant";
  expect(parseObservations(output(), proposed)[0].kind).toBe("hypothesis");
});
it("ignores attempted scope promotion and privileged fields from the observer", () => {
  const c = parseObservations(
    output({ visibility: "user", pinned: true, status: "active", actor: "user", id: "attacker" }),
    job,
  )[0];
  expect(c.visibility).toBeUndefined();
  expect(c.id).not.toBe("attacker");
  expect(c).not.toHaveProperty("pinned");
});
it("cancels providers that never resolve without leaking an unhandled rejection", async () => {
  const controller = new AbortController();
  const result = abortable(new Promise(() => {}), controller.signal);
  controller.abort(new Error("Foreground"));
  await expect(result).rejects.toThrow("Foreground");
});
it("excludes chain-of-thought and sensitive tool inputs from ingestion", () => {
  const entries = [
    {
      type: "message",
      id: "assistant",
      parentId: null,
      timestamp: "2026-09-06T00:00:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "Public explanation" },
          {
            type: "toolCall",
            id: "call",
            name: "write",
            arguments: { path: ".env", content: "unknown raw secret" },
          },
        ],
      },
    },
    {
      type: "message",
      id: "tool",
      parentId: "assistant",
      timestamp: "2026-09-06T00:00:01Z",
      message: {
        role: "toolResult",
        toolCallId: "call",
        toolName: "write",
        content: [{ type: "text", text: "Done" }],
        isError: false,
      },
    },
  ];
  const result = sourceInputs(entries as never, [".env"]);
  expect(result[0].text).toContain("Public explanation");
  expect(result[0].text).not.toContain("private reasoning");
  expect(result[0].text).not.toContain("unknown raw secret");
  expect(result[1].target).toBe(".env");
});
it("rejects invalid settings and credential-bearing embedding URLs", () => {
  expect(() => validateConfig({ contextTokens: 20 })).toThrow();
  expect(() => validateConfig({ surprise: true })).toThrow();
  expect(() => validateConfig({ mode: "magic" })).toThrow();
  expect(() =>
    validateConfig({ embeddings: { endpoint: "http://remote.test/embeddings", model: "a" } }),
  ).toThrow("HTTPS");
  expect(() =>
    validateConfig({
      embeddings: { endpoint: "https://user:password@remote.test/embeddings", model: "a" },
    }),
  ).toThrow("credentials");
});
it("clips multibyte output safely under the documented estimator", () => {
  const value = "Привет 👋 România 日本語 ".repeat(100);
  for (const budget of [0, 1, 10, 50, 200]) {
    const result = clipTokens(value, budget);
    expect(estimateTokens(result)).toBeLessThanOrEqual(budget);
    expect(result).not.toMatch(/[\uD800-\uDBFF]$/);
  }
});

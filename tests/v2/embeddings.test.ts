import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchEmbeddings } from "../../src/v2/embeddings.js";
import { MemoryService } from "../../src/v2/service.js";

let server: Server,
  endpoint: string,
  mode = "valid",
  directory: string;
beforeEach(async () => {
  mode = "valid";
  directory = mkdtempSync(join(tmpdir(), "remendra-embedding-"));
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const { input } = JSON.parse(body);
      response.setHeader("Content-Type", "application/json");
      if (mode === "error") {
        response.writeHead(503);
        response.end("unavailable");
        return;
      }
      response.end(
        JSON.stringify({
          data: input
            .map((text: string, index: number) => ({
              index: mode === "duplicate" ? 0 : index,
              embedding:
                mode === "dimensions" && index > 0
                  ? [1, 0, 0]
                  : text.includes("PostgreSQL") || text.includes("database")
                    ? [1, 0]
                    : [0, 1],
            }))
            .reverse(),
          usage: { total_tokens: 20 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("No server address");
  endpoint = `http://127.0.0.1:${address.port}/embeddings`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  rmSync(directory, { recursive: true, force: true });
});

it("matches returned vectors to input indexes and rejects malformed dimensions", async () => {
  const config = { endpoint, model: "local-test" };
  const result = await fetchEmbeddings(config, ["PostgreSQL", "other"]);
  expect(result.vectors).toEqual([
    [1, 0],
    [0, 1],
  ]);
  expect(result.tokens).toBe(20);
  mode = "dimensions";
  await expect(fetchEmbeddings(config, ["one", "two"])).rejects.toThrow("dimensions");
  mode = "duplicate";
  await expect(fetchEmbeddings(config, ["one", "two"])).rejects.toThrow("Invalid");
});
it("indexes and searches through the real service with shared budget accounting", async () => {
  const service = new MemoryService(join(directory, "memory.sqlite"), directory);
  try {
    service.configSet({ embeddings: { endpoint, model: "local-test" } });
    const scope = {
      projectId: service.project("/test"),
      sessionId: "session",
      entryIds: ["entry"],
    };
    const s = service.ingest(scope, [
      {
        entryId: "entry",
        role: "user",
        text: "PostgreSQL storage",
        timestamp: "2026-09-06T00:00:00Z",
      },
    ]);
    const source = service.store.source(s.keys[0])!;
    service.record(
      scope,
      {
        text: source.text,
        kind: "fact",
        evidence: [{ sourceKey: source.key, hash: source.hash, start: 0, end: source.text.length }],
      },
      "user",
    );
    expect((await service.embed(scope)).indexed).toBe(1);
    expect((await service.embed(scope, "database")).hits[0].claim.text).toBe("PostgreSQL storage");
    expect(service.status(scope).budget.spent).toBe(40);
    expect(service.status(scope).budget.reserved).toBe(0);
    // Semantic search is project-wide, so cross-session queries find results
    expect(
      (await service.embed({ ...scope, sessionId: "another" }, "database")).hits[0].claim.text,
    ).toBe("PostgreSQL storage");
    // Different project should return empty
    expect(
      (await service.embed({ ...scope, projectId: "other-project" }, "database")).hits,
    ).toEqual([]);
  } finally {
    service.close();
  }
});
it("rejects missing credentials before contacting an endpoint", async () => {
  await expect(
    fetchEmbeddings({ endpoint, model: "local", apiKeyEnv: "REMENDRA_TEST_UNSET_SECRET" }, [
      "hello",
    ]),
  ).rejects.toThrow("Set REMENDRA_TEST");
});

describe("embedding text and prefixes", () => {
  it("uses the task prefixes known models were trained with, unless configured", async () => {
    const { embeddingPrefixes, memoryEmbeddingText } = await import("../../src/v2/embeddings.js");
    const gemma = { endpoint, model: "embeddinggemma:latest" };
    expect(embeddingPrefixes(gemma).query).toBe("task: search result | query: ");
    expect(memoryEmbeddingText(gemma, "API on Hetzner", ["cloud provider", "hosting"])).toBe(
      "title: none | text: API on Hetzner (cloud provider, hosting)",
    );
    expect(embeddingPrefixes({ endpoint, model: "nomic-embed-text" }).document).toBe(
      "search_document: ",
    );
    expect(embeddingPrefixes({ endpoint, model: "intfloat/multilingual-e5-large" }).query).toBe(
      "query: ",
    );
    expect(embeddingPrefixes({ endpoint, model: "text-embedding-3-small" })).toEqual({
      query: "",
      document: "",
    });
    expect(embeddingPrefixes({ endpoint, model: "embeddinggemma", queryPrefix: "" }).query).toBe(
      "",
    );
  });
});

describe("transient embedding failures", () => {
  it("retries and splits a batch when the server drops requests, and gives up with its status", async () => {
    const { fetchEmbeddingsResilient, EmbeddingHttpError } =
      await import("../../src/v2/embeddings.js");
    expect(new EmbeddingHttpError(401, "").transient).toBe(false);
    expect(new EmbeddingHttpError(400, "invalid model").transient).toBe(false);
    expect(new EmbeddingHttpError(429, "").transient).toBe(true);
    let calls = 0;
    const flaky = createServer((request, response) => {
      let body = "";
      request.on("data", (c) => (body += c));
      request.on("end", () => {
        const { input } = JSON.parse(body) as { input: string[] };
        calls++;
        // Like Ollama's runner under GPU pressure: batches of more than one and every
        // other single request come back as HTTP 400 "... EOF".
        if (input.length > 1 || calls % 2 === 1) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(
            '{"error":{"message":"do embedding request: Post \\"http://127.0.0.1:1/v1/embeddings\\": EOF"}}',
          );
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ data: [{ index: 0, embedding: [input[0].length, 1] }] }));
      });
    });
    await new Promise<void>((done) => flaky.listen(0, "127.0.0.1", done));
    const { port } = flaky.address() as { port: number };
    try {
      const config = { endpoint: `http://127.0.0.1:${port}/embeddings`, model: "m" };
      const result = await fetchEmbeddingsResilient(config, ["a", "bb", "ccc"], 10000);
      expect(result.vectors).toEqual([
        [1, 1],
        [2, 1],
        [3, 1],
      ]);
      mode = "error";
      await expect(fetchEmbeddingsResilient({ endpoint, model: "m" }, ["x"], 5000)).rejects.toThrow(
        "HTTP 503",
      );
    } finally {
      await new Promise<void>((done) => flaky.close(() => done()));
    }
  });
});

it("keeps the vectors it got when a cold server runs out the clock", async () => {
  // Batches fail like Ollama's crashing runner; the first single answers, later ones hang.
  let singles = 0;
  const cold = createServer((request, response) => {
    let body = "";
    request.on("data", (c) => (body += c));
    request.on("end", () => {
      const { input } = JSON.parse(body) as { input: string[] };
      if (input.length > 1) {
        response.writeHead(400);
        response.end('{"error":{"message":"do embedding request: EOF"}}');
        return;
      }
      if (++singles > 1) return; // never answers
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }], usage: { total_tokens: 3 } }),
      );
    });
  });
  await new Promise<void>((done) => cold.listen(0, "127.0.0.1", done));
  const service = new MemoryService(join(directory, "memory.sqlite"), directory);
  try {
    const { port } = cold.address() as { port: number };
    service.configSet({ embeddings: { endpoint: `http://127.0.0.1:${port}/e`, model: "m" } });
    const scope = {
      projectId: service.project("/test"),
      sessionId: "session",
      entryIds: ["a", "b"],
    };
    for (const [entryId, text] of [
      ["a", "PostgreSQL storage"],
      ["b", "Redis cache"],
    ]) {
      const key = service.ingest(scope, [
        { entryId, role: "user", text, timestamp: "2026-09-06T00:00:00Z" },
      ]).keys[0];
      const source = service.store.source(key)!;
      service.record(
        scope,
        {
          text,
          kind: "fact",
          evidence: [{ sourceKey: key, hash: source.hash, start: 0, end: text.length }],
        },
        "user",
      );
    }
    const result = await service.embed(scope, undefined, 1500);
    expect(result).toMatchObject({ indexed: 1, incomplete: true });
    // The stored one is not embedded again; the other is still a candidate.
    expect((await service.embed(scope, undefined, 300).catch(() => ({ indexed: 0 }))).indexed).toBe(
      0,
    );
  } finally {
    service.close();
    cold.closeAllConnections();
    await new Promise<void>((done) => cold.close(() => done()));
  }
});

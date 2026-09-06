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
    expect((await service.embed({ ...scope, sessionId: "another" }, "database")).hits[0].claim.text).toBe("PostgreSQL storage");
    // Different project should return empty
    expect((await service.embed({ ...scope, projectId: "other-project" }, "database")).hits).toEqual([]);
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

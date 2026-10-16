// Bundles benchmarks/beam/beam.ts with tsup (source imports use .js extensions) and runs it.
import { build } from "tsup";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outDir = mkdtempSync(join(tmpdir(), "remendra-beam-"));
await build({
  entry: { beam: new URL("./beam.ts", import.meta.url).pathname },
  outDir,
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  silent: true,
  config: false,
});
await import(pathToFileURL(join(outDir, "beam.js")).href);

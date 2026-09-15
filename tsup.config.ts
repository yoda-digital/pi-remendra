import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "index.ts",
    "v2/worker": "src/v2/worker.ts",
    "v2/cli": "src/v2/cli.ts",
  },
  format: ["esm"],
  outDir: "dist",
  bundle: true,
  splitting: false,
  dts: false,
  clean: true,
  treeshake: true,
  sourcemap: true,
  target: "es2022",
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-ai/compat",
    "@earendil-works/pi-tui",
    "typebox",
    "@sinclair/typebox",
  ],
});

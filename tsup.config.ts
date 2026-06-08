import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
  sourcemap: true,
  treeshake: true,
  target: "node18",
  // bullmq is a peer dep — keep it external so the consumer's installed version is used.
  external: ["bullmq"],
});

import { createRequire as createBuildRequire } from "node:module";
const buildRequire = createBuildRequire(import.meta.url);
import { build } from "esbuild";
import { readdir, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
await mkdir(".cache/tests", { recursive: true });
const files = (await readdir("tests")).filter((name) =>
  name.endsWith(".test.ts"),
);
for (const file of [
  ...files,
  "fixture-server.ts",
  "public-fixture-server.ts",
  "cli.ts",
]) {
  await build({
    entryPoints: [file === "cli.ts" ? "src/cli.ts" : `tests/${file}`],
    outfile: `.cache/tests/${file.replace(/\.ts$/, ".mjs")}`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["@napi-rs/keyring"],
    alias: {
      "@n1xyz/nord-ts": buildRequire.resolve("@n1xyz/nord-ts"),
      "@n1xyz/proton": buildRequire.resolve("@n1xyz/proton"),
    },
    banner: {
      js: 'import { createRequire as __nordMcpCreateRequire } from "node:module"; const require = __nordMcpCreateRequire(import.meta.url); const __filename = require("node:url").fileURLToPath(import.meta.url); const __dirname = __filename.slice(0, __filename.lastIndexOf("/"));',
    },
  });
}
const result = spawnSync(
  process.execPath,
  ["--test", ...files.map((f) => `.cache/tests/${f.replace(/\.ts$/, ".mjs")}`)],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;

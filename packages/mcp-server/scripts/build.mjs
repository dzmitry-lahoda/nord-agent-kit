import { createRequire as createBuildRequire } from "node:module";
const buildRequire = createBuildRequire(import.meta.url);
import { build } from "esbuild";
import { mkdir, copyFile, chmod, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  alias: {
    "@n1xyz/proton": buildRequire.resolve("@n1xyz/proton"),
    "@n1xyz/nord-ts": buildRequire.resolve("@n1xyz/nord-ts"),
  },
  external: ["@napi-rs/keyring"],
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url); const __filename = require("node:url").fileURLToPath(import.meta.url); const __dirname = require("node:path").dirname(__filename);',
  },
  legalComments: "linked",
});
await build({
  entryPoints: ["src/browser.ts"],
  outfile: "dist/browser.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  legalComments: "linked",
});
await copyFile("src/browser.html", "dist/browser.html");
await copyFile("src/browser.css", "dist/browser.css");
await chmod("dist/cli.js", 0o755);

import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const root = mkdtempSync(join(realpathSync(tmpdir()), "nord-mcp-install-"));
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout;
}
try {
  const [pack] = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", root]),
  );
  assert.equal(pack.version, manifest.version);
  const expectedFiles = [
    "package.json",
    "README.md",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.txt",
    "licenses/GPL-3.0-only.txt",
    "licenses/LGPL-3.0-only.txt",
    "licenses/rpc-websockets.LICENSE.txt",
    "licenses/wallet-standard-app.LICENSE.txt",
    "dist/cli.js",
    "dist/cli.js.LEGAL.txt",
    "dist/browser.js",
    "dist/browser.html",
    "dist/browser.css",
    "docs/usage.md",
    "docs/testing.md",
    "docs/devnet-acceptance.md",
    "docs/nord-adapter.md",
    "docs/releasing.md",
    "evaluations/README.md",
    "evaluations/eval.xml",
  ];
  assert.deepEqual(
    pack.files.map((file) => file.path).sort(),
    expectedFiles.sort(),
  );
  assert.ok(
    pack.files.find((file) => file.path === "dist/cli.js").mode & 0o111,
  );
  run("npm", [
    "install",
    "--prefix",
    root,
    "--ignore-scripts",
    "--omit=dev",
    "--omit=optional",
    join(root, pack.filename),
  ]);
  const installed = join(root, "node_modules/@n1xyz/nord-mcp-server");
  assert.equal(
    JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).license,
    "Apache-2.0",
  );
  for (const file of ["LICENSE", "NOTICE"]) {
    assert.equal(
      readFileSync(join(installed, file), "utf8"),
      readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8"),
      `Published ${file} must match the repository ${file}`,
    );
  }
  for (const file of expectedFiles.filter(
    (path) =>
      path.startsWith("licenses/") || path === "THIRD_PARTY_NOTICES.txt",
  )) {
    assert.equal(
      readFileSync(join(installed, file), "utf8"),
      readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
      `Published ${file} must match the reviewed notice`,
    );
  }
  const binary = join(installed, "dist/cli.js");
  assert.equal(
    run(process.execPath, [binary, "--version"]).trim(),
    manifest.version,
  );
  assert.match(run(process.execPath, [binary, "--help"]), /nord-mcp setup/);
  const check = fileURLToPath(new URL("./packed-check.mjs", import.meta.url));
  run(process.execPath, [
    check,
    binary,
    ...(process.argv.includes("--live") ? ["--live"] : []),
  ]);
  console.log(
    JSON.stringify({
      node: process.versions.node,
      packedInstall: true,
      optionalKeyringAbsent: true,
      installedStdioDiscovery: true,
      publicDevnetReads: process.argv.includes("--live"),
      packageFiles: pack.files.length,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const binary = resolve(process.argv[2] ?? "dist/cli.js");
const live = process.argv.includes("--live");
const root = mkdtempSync(join(realpathSync(tmpdir()), "nord-mcp-packed-"));
const blockedConfig = join(root, "not-a-directory");
writeFileSync(blockedConfig, "public mode must not access profiles");
const client = new Client({ name: "packed-smoke", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [binary, "serve", "--public", "--network", "devnet"],
  env: { ...process.env, NORD_MCP_CONFIG_HOME: blockedConfig },
  cwd: root,
  stderr: "pipe",
});
// Drain diagnostics separately; stdout must contain only valid MCP messages.
transport.stderr?.resume();
try {
  await client.connect(transport, { timeout: 30000 });
  assert.equal(client.getServerVersion().version, manifest.version);
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ["nord_get_market", "nord_list_markets"],
  );
  assert.match(client.getInstructions(), /devnet/);
  if (live) {
    const result = await client.callTool({
      name: "nord_list_markets",
      arguments: { limit: 1 },
    });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.data.items.length, 1);
    const marketId = result.structuredContent.data.items[0].marketId;
    const market = await client.callTool({
      name: "nord_get_market",
      arguments: { marketId },
    });
    assert.equal(market.isError, false);
  }
  assert.equal(
    readFileSync(blockedConfig, "utf8"),
    "public mode must not access profiles",
  );
  console.log(
    JSON.stringify({
      node: process.versions.node,
      toolCount: 2,
      publicDevnetReads: live,
      profileRequired: false,
      stdout: "valid MCP only",
    }),
  );
} finally {
  await client.close();
  rmSync(root, { recursive: true, force: true });
}

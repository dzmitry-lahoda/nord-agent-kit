import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tempRoot } from "./temp";

const publicTools = ["nord_get_market", "nord_list_markets"];
const cli = resolve(".cache/tests/cli.mjs");
const fixture = resolve(".cache/tests/public-fixture-server.mjs");

for (const legacy of [false, true]) {
  test(`public CLI starts without profile storage and exposes only public tools (${legacy ? "legacy" : "v2"})`, async () => {
    const root = tempRoot("nord-public-");
    const blockedConfig = join(root, "not-a-directory");
    writeFileSync(blockedConfig, "must not be opened or changed");
    const args = [
      cli,
      "serve",
      "--public",
      ...(legacy ? ["--network", "mainnet"] : []),
    ];
    const config = {
      command: process.execPath,
      args,
      env: { NORD_MCP_CONFIG_HOME: blockedConfig },
      stderr: "pipe" as const,
    };
    const transport = legacy
      ? new LegacyTransport(config)
      : new StdioClientTransport(config);
    const client = legacy
      ? new LegacyClient({ name: "public-test", version: "1" })
      : new Client(
          { name: "public-test", version: "1" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        );
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), publicTools);
      assert.ok(
        tools.every(
          (t) =>
            t.outputSchema &&
            t.annotations?.readOnlyHint === true &&
            t.annotations?.destructiveHint === false,
        ),
      );
      assert.match(
        client.getInstructions()!,
        new RegExp(legacy ? "mainnet" : "devnet"),
      );
      // Unknown account/trading tools must fail even if the caller bypasses discovery.
      for (const name of [
        "nord_get_account",
        "nord_place_order",
        "nord_get_request",
      ]) {
        let rejected = false;
        try {
          rejected =
            (await client.callTool({ name, arguments: {} })).isError === true;
        } catch {
          rejected = true;
        }
        assert.equal(rejected, true, name);
      }
      assert.equal(
        readFileSync(blockedConfig, "utf8"),
        "must not be opened or changed",
      );
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("public tools paginate/filter markets and report bounded CLOB and indicative RFQ data", async () => {
  const client = new Client({ name: "public-test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fixture],
        stderr: "pipe",
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, false);
      return result.structuredContent as { data: Record<string, unknown> };
    };
    const first = await call("nord_list_markets", { limit: 1 });
    assert.equal(first.data.nextCursor, "0");
    assert.equal(
      (first.data.items as { marketId: string }[])[0]!.marketId,
      "0",
    );
    const next = await call("nord_list_markets", {
      limit: 1,
      cursor: first.data.nextCursor,
    });
    assert.equal((next.data.items as { marketId: string }[])[0]!.marketId, "2");
    assert.equal(next.data.nextCursor, null);
    const filtered = await call("nord_list_markets", {
      search: "sol",
      mode: "rfq",
    });
    assert.equal((filtered.data.items as unknown[]).length, 1);
    const empty = await call("nord_list_markets", { search: "nonexistent" });
    assert.deepEqual(empty.data.items, []);
    const clob = await call("nord_get_market", { marketId: "0" });
    const depth = clob.data.depth as {
      asks: string[][];
      bids: string[][];
      truncated: boolean;
    };
    assert.equal(depth.asks.length, 50);
    assert.equal(depth.bids.length, 50);
    assert.equal(depth.asks[0]![0], "50001");
    assert.equal(depth.truncated, true);
    const rfq = await call("nord_get_market", { marketId: "2" });
    assert.equal(rfq.data.depth, null);
    assert.deepEqual(rfq.data.capabilities, {
      limit: false,
      cancel: false,
      market: true,
    });
    assert.equal(
      (
        (rfq.data.live as Record<string, unknown>).rfq as Record<
          string,
          unknown
        >
      ).physicalTime,
      "2023-11-14T22:13:20Z",
    );
    for (const args of [{ limit: 51 }, { network: "mainnet" }]) {
      assert.equal(
        (await client.callTool({ name: "nord_list_markets", arguments: args }))
          .isError,
        true,
      );
    }
    const missing = await client.callTool({
      name: "nord_get_market",
      arguments: { marketId: "999" },
    });
    assert.equal(missing.isError, true);
    assert.equal(
      (missing.structuredContent as { error: { code: string } }).error.code,
      "MARKET_NOT_FOUND",
    );
  } finally {
    await client.close();
  }
});

test("public provider failures remain structured errors", async () => {
  const client = new Client({ name: "public-test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fixture, "--unavailable"],
        stderr: "pipe",
      }),
    );
    const result = await client.callTool({
      name: "nord_list_markets",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.equal(
      (result.structuredContent as { error: { code: string } }).error.code,
      "PROVIDER_UNAVAILABLE",
    );
  } finally {
    await client.close();
  }
});

test("public CLI rejects mixed modes and invalid flags before accessing storage", () => {
  const root = tempRoot("nord-public-args-");
  const config = join(root, "uncreated");
  try {
    for (const args of [
      ["serve", "--public", "--profile", "personal"],
      ["serve", "--public", "--storage", "file"],
      ["serve", "--public", "--owner-keyfile", "unused"],
      ["serve", "--public", "--account-id", "7"],
      ["serve", "--public", "--method", "browser"],
      ["serve", "--public", "--network", "invalid"],
      ["status", "--public"],
      ["setup", "--public"],
      ["serve", "--profile", "personal", "--network", "mainnet"],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        env: { ...process.env, NORD_MCP_CONFIG_HOME: config },
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.status, 1, args.join(" "));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /INVALID_ARGUMENTS/);
      assert.equal(existsSync(config), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

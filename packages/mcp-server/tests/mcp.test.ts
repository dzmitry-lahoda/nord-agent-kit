import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("legacy real STDIO client discovers all tools, paginates and preserves exact quantities", async () => {
  const transport = new LegacyTransport({
    command: process.execPath,
    args: [resolve(".cache/tests/fixture-server.mjs")],
    stderr: "pipe",
  });
  const client = new LegacyClient({ name: "test", version: "1" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 12);
    assert.ok(tools.every((t) => t.name.startsWith("nord_") && t.outputSchema));
    assert.equal(
      tools.find((t) => t.name === "nord_place_order")?.annotations
        ?.destructiveHint,
      true,
    );
    const result = await client.callTool({
      name: "nord_list_order_history",
      arguments: { limit: 1 },
    });
    const page = (
      result.structuredContent as {
        data: { items: { orderId: string }[]; nextCursor: string };
      }
    ).data;
    assert.equal(page.items[0]!.orderId, "9007199254740993");
    assert.equal(page.nextCursor, "9007199254740994");
    const next = await client.callTool({
      name: "nord_list_order_history",
      arguments: { limit: 1, cursor: page.nextCursor },
    });
    assert.equal(
      (next.structuredContent as { data: { nextCursor: null } }).data
        .nextCursor,
      null,
    );
    const invalid = await client.callTool({
      name: "nord_preview_order",
      arguments: { marketId: "0", side: "buy", type: "market", baseSize: "1" },
    });
    assert.equal(invalid.isError, true);
    const prepared = await client.callTool({
      name: "nord_get_request",
      arguments: { requestId: "never-sent" },
    });
    assert.equal(prepared.isError, true);
    assert.equal((prepared.structuredContent as { ok: boolean }).ok, false);
    assert.equal(
      (prepared.structuredContent as { data: { state: string } }).data.state,
      "prepared",
    );
    const unknown = await client.callTool({
      name: "nord_get_request",
      arguments: { requestId: "lost-response" },
    });
    assert.equal(
      (unknown.structuredContent as { data: { state: string } }).data.state,
      "unknown",
    );
  } finally {
    await client.close();
  }
});
test("modern pinned v2 STDIO client discovers and invokes read tools", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(".cache/tests/fixture-server.mjs")],
    stderr: "pipe",
  });
  const client = new Client(
    { name: "test", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 12);
    const result = await client.callTool({
      name: "nord_get_account",
      arguments: {},
    });
    assert.equal(result.isError, false);
    assert.equal(
      (result.structuredContent as { data: { balances: { amount: string }[] } })
        .data.balances[0]!.amount,
      "1234.56789",
    );
  } finally {
    await client.close();
  }
});

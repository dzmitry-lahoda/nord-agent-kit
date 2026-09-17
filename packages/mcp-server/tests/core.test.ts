import { tempRoot } from "./temp";
import { profile } from "./fixtures";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  chmodSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import crypto, { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import {
  Profiles,
  credentials,
  atomicWrite,
  readPrivate,
} from "../src/storage";
import { Journal, fingerprint } from "../src/journal";
import { exactJson, safeNumber, NordReads } from "../src/nord/reads";
import { orderSchema } from "../src/model";
import { prepareOrderQuantities, rfqReference } from "../src/order-preparation";

function temp(t: test.TestContext) {
  const path = tempRoot("nord-mcp-test-");
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
test("lossless JSON preserves large integers and decimal fractions as strings", () => {
  const data = exactJson(
    '{"id":18446744073709551615,"amount":0.1234567890123456789,"zero":0,"missing":null}',
  ) as Record<string, unknown>;
  assert.equal(data.id, "18446744073709551615");
  assert.equal(data.amount, "0.1234567890123456789");
  assert.equal(data.zero, "0");
  assert.equal(data.missing, null);
  assert.throws(() => safeNumber("9007199254740993"));
});
test("file storage is explicit, private, and rejects symlinks or broad permissions", async (t) => {
  const root = temp(t),
    profiles = new Profiles(root),
    store = await credentials(profiles, "file"),
    id = randomUUID();
  await store.put(id, new Uint8Array([1, 2, 3]));
  assert.deepEqual(await store.get(id), new Uint8Array([1, 2, 3]));
  const path = join(root, "credentials", id);
  chmodSync(path, 0o644);
  await assert.rejects(store.get(id));
  chmodSync(path, 0o600);
  await store.delete(id);
  symlinkSync(join(root, "elsewhere"), path);
  await assert.rejects(store.put(id, new Uint8Array([3])));
});
test("profile lock is released on process death and rejects a concurrent process", (t) => {
  const profiles = new Profiles(temp(t));
  const release = profiles.lock("test");
  const script = `import { DatabaseSync } from 'node:sqlite';const d=new DatabaseSync(${JSON.stringify(join(profiles.root, "test", "lock.sqlite"))});d.exec('BEGIN EXCLUSIVE');`;
  const other = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    script,
  ]);
  assert.notEqual(other.status, 0);
  release();
  assert.equal(
    spawnSync(process.execPath, ["--input-type=module", "-e", script]).status,
    0,
  );
  const again = profiles.lock("test");
  again();
});
test("journal retains pre-send identity, rejects ID conflicts, blocks duplicate unresolved intent across restart", (t) => {
  const profiles = new Profiles(temp(t));
  let journal = new Journal(profiles, "test");
  const args = { marketId: "1", baseSize: "0.1" };
  const record = journal.begin("trade-1", "dev:owner:1", "place", args, "100");
  assert.equal(record.fresh, true);
  journal.beforeSend("trade-1", {
    unsignedPayload: "AQ==",
    hash: "abc",
    timestamp: "123",
    nonce: 3,
  });
  journal.close();
  journal = new Journal(profiles, "test");
  t.after(() => journal.close());
  assert.equal(journal.nonce(), 3);
  assert.equal(journal.get("trade-1")?.state, "submitting");
  assert.equal(
    journal.begin("trade-1", "dev:owner:1", "place", args, "100").fresh,
    false,
  );
  assert.throws(() =>
    journal.begin(
      "trade-1",
      "dev:owner:1",
      "place",
      { ...args, baseSize: "1" },
      "100",
    ),
  );
  assert.throws(() =>
    journal.begin("trade-2", "dev:owner:1", "place", args, "100"),
  );
  journal.receipt("trade-1", "18446744073709551615", { fill: "10" });
  assert.equal(journal.get("trade-1")?.state, "accepted");
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
});
test("order policy requires exactly one size and explicit protection", () => {
  const base = {
    marketId: "1",
    side: "buy",
    type: "market",
    slippageBps: 50,
    baseSize: "1",
  };
  assert.equal(orderSchema.parse(base).reduceOnly, false);
  assert.throws(() => orderSchema.parse({ ...base, quoteNotional: "100" }));
  assert.throws(() => orderSchema.parse({ ...base, slippageBps: undefined }));
  assert.throws(() => orderSchema.parse({ ...base, baseSize: 1 }));
  assert.throws(() => orderSchema.parse({ ...base, owner: "override" }));
});
for (const side of ["buy", "sell"] as const) {
  test(`protective ${side} rounding stays inside user bound and derived sizes round down`, () => {
    const market = {
      mode: "clob" as const,
      priceDecimals: 2,
      sizeDecimals: 3,
      referencePrice: "100.123",
    };
    const out = prepareOrderQuantities(
      { side, type: "market", baseSize: "1.234", slippageBps: 10 },
      market,
    );
    assert.equal(out.price, side === "buy" ? "100.22" : "100.03");
    assert.throws(() =>
      prepareOrderQuantities(
        { side, type: "limit", baseSize: "1.2345", limitPrice: "100" },
        market,
      ),
    );
    assert.throws(() =>
      prepareOrderQuantities(
        { side, type: "limit", baseSize: "1", limitPrice: "100.001" },
        market,
      ),
    );
    const quote = prepareOrderQuantities(
      { side, type: "market", quoteNotional: "100", slippageBps: 100 },
      { ...market, mode: "rfq", referencePrice: "100" },
    );
    assert.equal(quote.size, side === "buy" ? "0.99" : "1");
    assert.equal(quote.quoteSize, undefined);
    const native = prepareOrderQuantities(
      { side, type: "market", quoteNotional: "100.00001", slippageBps: 10 },
      market,
    );
    assert.equal(native.quoteSize, "100.00001");
  });
}
test("RFQ reference requires complete fresh sampling and current-index observation", () => {
  const sample = {
    bid: "99",
    ask: "101",
    sampledIndex: "100",
    currentIndex: "110",
    sampledAtMs: 100000,
    indexObservedAtMs: 125000,
    nowMs: 130000,
  };
  assert.equal(rfqReference(sample), "110");
  assert.throws(() => rfqReference({ ...sample, nowMs: 130001 }));
  assert.throws(() => rfqReference({ ...sample, indexObservedAtMs: 119999 }));
  assert.throws(() => rfqReference({ ...sample, sampledIndex: "0" }));
  assert.throws(() => rfqReference({ ...sample, bid: "102" }));
});

test("an absent Nord owner produces an actionable setup error without masking provider outages", async () => {
  for (const status of [404, 503]) {
    const reads = new NordReads(
      "devnet",
      (async () => new Response(null, { status })) as typeof fetch,
    );
    await assert.rejects(
      reads.user("11111111111111111111111111111111"),
      (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error);
        assert.equal(
          error.code,
          status === 404 ? "ACCOUNT_NOT_FOUND" : "PROVIDER_UNAVAILABLE",
        );
        if (status === 404) assert.match(error.message, /Deposit collateral/);
        return true;
      },
    );
  }
});

test("journal client IDs stay within Nord's U63 domain and survive restart unchanged", (t) => {
  const profiles = new Profiles(temp(t));
  let entropy = Buffer.alloc(8);
  const random = t.mock.method(crypto, "randomBytes", () => entropy);
  syncBuiltinESMExports();
  let journal = new Journal(profiles, "client-id");
  const recorded: {
    id: string;
    args: { attempt: number };
    clientOrderId: string;
  }[] = [];
  try {
    for (const [attempt, hex] of [
      "0000000000000000",
      "7fffffffffffffff",
      "8000000000000000",
      "ffffffffffffffff",
    ].entries()) {
      entropy = Buffer.from(hex, "hex");
      const id = `domain-${attempt}`,
        args = { attempt };
      const { record } = journal.begin(
        id,
        "devnet:owner:7",
        "place",
        args,
        "100",
      );
      assert.ok(BigInt(record.clientOrderId) >= 0n);
      assert.ok(
        BigInt(record.clientOrderId) <= 9223372036854775807n,
        "Nord ClientOrderId is U63, even though its protobuf field is uint64",
      );
      recorded.push({ id, args, clientOrderId: record.clientOrderId });
    }
    journal.close();
    journal = new Journal(profiles, "client-id");
    for (const previous of recorded) {
      const retry = journal.begin(
        previous.id,
        "devnet:owner:7",
        "place",
        previous.args,
        "101",
      );
      assert.equal(retry.fresh, false);
      assert.equal(retry.record.clientOrderId, previous.clientOrderId);
    }
  } finally {
    journal.close();
    random.mock.restore();
    syncBuiltinESMExports();
  }
});

test("profile listing reports damaged entries while preserving healthy and pending profiles", (t) => {
  const profiles = new Profiles(temp(t));
  profiles.save({ ...profile, name: "healthy" });
  profiles.save({ ...profile, name: "pending", state: "pending" }, true);
  const malformed = profiles.path("malformed");
  writeFileSync(malformed, "not json SECRET", { mode: 0o600 });
  const future = profiles.path("future");
  writeFileSync(future, JSON.stringify({ ...profile, version: 99 }), {
    mode: 0o600,
  });
  profiles.save({ ...profile, name: "unsafe" });
  chmodSync(profiles.path("unsafe"), 0o644);
  const warnings: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => {
    warnings.push(chunk);
    return true;
  });
  assert.deepEqual(
    profiles
      .list()
      .map((p) => p.name)
      .sort(),
    ["healthy", "pending"],
  );
  for (const name of ["malformed", "future", "unsafe"]) {
    assert.ok(warnings.some((warning) => warning.includes(`Profile ${name} `)));
    assert.throws(() => profiles.require(name));
  }
  assert.ok(warnings.every((warning) => !warning.includes("SECRET")));
});

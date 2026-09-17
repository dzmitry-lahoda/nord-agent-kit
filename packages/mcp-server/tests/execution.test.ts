import { tempRoot } from "./temp";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { sizeDelimitedEncode } from "@bufbuild/protobuf/wire";
import { Side, proto } from "@n1xyz/nord-ts";
import { NordSession } from "../src/nord/session";
import { Profiles } from "../src/storage";
import { Runtime, serializable } from "../src/runtime";
import { clobResult } from "../src/receipts";
import { profile, FixtureReads } from "./fixtures";
import type { OrderInput } from "../src/model";

const order: OrderInput = {
  marketId: "0",
  side: "buy",
  type: "market",
  baseSize: "2",
  slippageBps: 100,
  reduceOnly: false,
};
function harness(
  t: test.TestContext,
  requestId: string,
  post: () => Promise<Response>,
  failReceipt = false,
  profiles = new Profiles(tempRoot("nord-mcp-execution-")),
) {
  const root = profiles.root;
  profiles.save(profile);
  const runtime = new Runtime(profiles, profile, new FixtureReads());
  t.after(async () => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  const user = new NordSession({
    transport: { post },
    markets: [{ marketId: 0, priceDecimals: 1, sizeDecimals: 5 }],
    getTimestamp: async () => 1700000000n,
    sessionId: 42n,
    signSessionFn: async () => new Uint8Array(64),
    hooks: {
      beforeSubmit: async (action) =>
        runtime.journal.beforeSend(requestId, action),
      afterReceipt: async (receipt) => {
        if (failReceipt) throw new Error("disk full after execution");
        runtime.journal.receipt(
          requestId,
          receipt.actionId.toString(),
          serializable(receipt),
        );
      },
    },
  });
  Object.defineProperty(runtime, "user", { value: user, writable: true });
  return { runtime, user };
}
function response(receipt: proto.Receipt) {
  return new Response(
    new Uint8Array(sizeDelimitedEncode(proto.ReceiptSchema, receipt)).buffer,
  );
}
test("lost transport response never blindly submits the same or renamed intent", async (t) => {
  let sends = 0;
  const { runtime } = harness(t, "lost", async () => {
    sends++;
    throw new Error("lost response");
  });
  assert.equal((await runtime.place("lost", order)).state, "unknown");
  assert.equal(sends, 1);
  assert.equal((await runtime.place("lost", order)).state, "unknown");
  assert.equal(sends, 1);
  await assert.rejects(runtime.place("new-id", order));
  assert.equal(sends, 1);
  assert.ok((await runtime.account()).balances.length);
});
test("receipt persistence failure after execution remains unknown across a repeated call", async (t) => {
  let sends = 0;
  const receipt = create(proto.ReceiptSchema, {
    actionId: 101n,
    kind: {
      case: "tradeOrPlace",
      value: {
        fills: [],
        orderUpdates: [],
      },
    },
  });
  const { runtime } = harness(
    t,
    "commit-failed",
    async () => {
      sends++;
      return response(receipt);
    },
    true,
  );
  assert.equal((await runtime.place("commit-failed", order)).state, "unknown");
  assert.equal((await runtime.place("commit-failed", order)).state, "unknown");
  assert.equal(sends, 1);
});
test("accepted receipt survives missing MCP response and exact partial-fill quantities are returned", async (t) => {
  let sends = 0;
  const receipt = create(proto.ReceiptSchema, {
    actionId: 9007199254740993n,
    kind: {
      case: "tradeOrPlace",
      value: {
        fills: [
          {
            orderId: 9007199254740995n,
            price: 500001n,
            size: 100000n,
            accountId: 9,
          },
        ],
        orderUpdates: [],
      },
    },
  });
  const { runtime } = harness(t, "filled", async () => {
    sends++;
    return response(receipt);
  });
  const first = await runtime.place("filled", order);
  assert.equal(first.state, "accepted");
  const result = first.result as ReturnType<typeof clobResult>;
  assert.equal(result.filledBaseSize, "1");
  assert.equal(result.unfilledBaseSize, "1");
  assert.equal(result.filledQuoteNotional, "50000.1");
  assert.equal(result.actionId, "9007199254740993");
  const duplicate = await runtime.place("filled", order);
  assert.equal(duplicate.state, "accepted");
  assert.equal(sends, 1);
});
test("RFQ user placement passes the durable hooks before transport", async (t) => {
  const receipt = create(proto.ReceiptSchema, {
    actionId: 123n,
    kind: {
      case: "atomic",
      value: {
        results: [{ inner: { case: "rfqResult", value: { orderId: 456n } } }],
      },
    },
  });
  const { runtime, user } = harness(t, "rfq", async () => {
    assert.equal(runtime.journal.get("rfq")?.state, "submitting");
    return response(receipt);
  });
  runtime.journal.begin("rfq", "fixture", "place", {}, "100");
  const result = await user.placeRfqOrder({
    marketId: 0,
    side: Side.Bid,
    price: "100",
    size: "1",
    accountId: 7,
    clientOrderId: "123",
  });
  assert.equal(result.orderId, 456n);
  assert.equal(runtime.journal.get("rfq")?.state, "accepted");
});
test("an expired session never submits a renewal", async (t) => {
  let sends = 0;
  const { runtime } = harness(t, "unused", async () => {
    sends++;
    throw new Error();
  });
  const reads = runtime.reads as FixtureReads;
  reads.timestamp = async () => profile.expiry + 1;
  await assert.rejects(runtime.renew());
  assert.equal(sends, 0);
});

test("renewal clamps its signed expiry to the authoritative deadline", async (t) => {
  const now = 1700000000,
    oldExpiry = now + 3600,
    deadline = now + 7200;
  let expiry = oldExpiry;
  const requestId = `renew:42:${oldExpiry}`;
  const { runtime } = harness(t, requestId, async () => {
    assert.equal(runtime.journal.get(requestId)?.args.expiry, String(deadline));
    expiry = deadline;
    return response(
      create(proto.ReceiptSchema, {
        actionId: 201n,
        kind: { case: "sessionRefreshed", value: { expiry: BigInt(deadline) } },
      }),
    );
  });
  runtime.reads.session = async () => ({ expiry, deadline });
  const result = await runtime.renew();
  assert.equal(result.expiry, String(deadline));
  assert.equal(runtime.journal.get(requestId)?.state, "accepted");
});

test("ambiguous renewal is verified from remote expiry without a second action", async (t) => {
  const now = 1700000000,
    oldExpiry = now + 3600,
    deadline = now + 7200;
  let expiry = oldExpiry,
    sends = 0;
  const requestId = `renew:42:${oldExpiry}`;
  const { runtime } = harness(t, requestId, async () => {
    sends++;
    expiry = deadline;
    throw new Error("lost renewal receipt");
  });
  runtime.reads.session = async () => ({ expiry, deadline });
  assert.equal((await runtime.renew()).expiry, String(deadline));
  await runtime.renew();
  assert.equal(sends, 1);
});

test("revocation is reported only after the exact remote session disappears", async (t) => {
  let revoked = false;
  const { runtime } = harness(t, "revoke:42", async () => {
    revoked = true;
    return response(
      create(proto.ReceiptSchema, {
        actionId: 202n,
        kind: { case: "selfSessionRevoked", value: {} },
      }),
    );
  });
  const original = runtime.reads.user.bind(runtime.reads);
  runtime.reads.user = async (owner) =>
    revoked ? { accountIds: ["7"], sessions: {} } : original(owner);
  assert.equal((await runtime.revoke()).revoked, true);
  assert.equal(runtime.profile.state, "revoked");
});

test("unverified revocation cannot claim success", async (t) => {
  const { runtime } = harness(t, "revoke:42", async () =>
    response(
      create(proto.ReceiptSchema, {
        actionId: 202n,
        kind: { case: "selfSessionRevoked", value: {} },
      }),
    ),
  );
  await assert.rejects(runtime.revoke());
  assert.equal(runtime.profile.state, "active");
});

for (const kind of ["place", "cancel", "renew", "revoke"] as const) {
  test(`prepared ${kind} resumes after restart only before an action identity exists`, async (t) => {
    const requestId =
      kind === "renew"
        ? "renew:42:1700003600"
        : kind === "revoke"
          ? "revoke:42"
          : `resume-${kind}`;
    const profiles = new Profiles(tempRoot("nord-mcp-resume-"));
    const before = new Runtime(profiles, profile, new FixtureReads());
    const args =
      kind === "place"
        ? order
        : kind === "cancel"
          ? { orderId: "9007199254740993" }
          : kind === "renew"
            ? { expiry: "1700007200" }
            : {};
    const original = before.journal.begin(
      requestId,
      "devnet:11111111111111111111111111111111:7",
      kind,
      args,
      "100",
    ).record;
    await before.close();
    let sends = 0;
    const { runtime } = harness(
      t,
      requestId,
      async () => {
        sends++;
        assert.equal(
          runtime.journal.get(requestId)?.clientOrderId,
          original.clientOrderId,
        );
        assert.equal(runtime.journal.get(requestId)?.state, "submitting");
        const receiptKind: proto.Receipt["kind"] =
          kind === "place"
            ? {
                case: "tradeOrPlace",
                value: create(proto.Receipt_PlaceOrderResultSchema, {}),
              }
            : kind === "cancel"
              ? {
                  case: "cancelOrderResult",
                  value: create(proto.Receipt_CancelOrderResultSchema, {}),
                }
              : kind === "renew"
                ? {
                    case: "sessionRefreshed",
                    value: create(proto.Receipt_SessionRefreshedSchema, {
                      expiry: 1700007200n,
                    }),
                  }
                : {
                    case: "selfSessionRevoked",
                    value: create(proto.Receipt_SelfSessionRevokedSchema, {}),
                  };
        return response(
          create(proto.ReceiptSchema, { actionId: 201n, kind: receiptKind }),
        );
      },
      false,
      profiles,
    );
    if (kind === "renew")
      runtime.reads.session = async () => ({
        expiry: sends ? 1700007200 : 1700003600,
        deadline: 1700007200,
      });
    if (kind === "revoke") {
      const user = runtime.reads.user.bind(runtime.reads);
      runtime.reads.user = async (owner) =>
        sends ? { accountIds: ["7"], sessions: {} } : user(owner);
    }
    const invoke = () =>
      kind === "place"
        ? runtime.place(requestId, order)
        : kind === "cancel"
          ? runtime.cancel(requestId, "9007199254740993")
          : kind === "renew"
            ? runtime.renew()
            : runtime.revoke();
    await invoke();
    assert.equal(runtime.journal.get(requestId)?.state, "accepted");
    await invoke();
    assert.equal(sends, 1);
  });
}

test("a prepared retry revalidates the session and rejects changed arguments without sending", async (t) => {
  let sends = 0;
  const { runtime } = harness(t, "prepared-expired", async () => {
    sends++;
    throw new Error("must not send");
  });
  runtime.journal.begin(
    "prepared-expired",
    "devnet:11111111111111111111111111111111:7",
    "place",
    order,
    "100",
  );
  await assert.rejects(
    runtime.place("prepared-expired", { ...order, baseSize: "3" }),
    { code: "REQUEST_CONFLICT" },
  );
  runtime.reads.timestamp = async () => profile.expiry + 1;
  const result = await runtime.place("prepared-expired", order);
  assert.equal(result.state, "not_submitted");
  assert.equal(result.error?.code, "SESSION_EXPIRED");
  assert.equal(sends, 0);
});

test("resting order identity comes from posted, not updates to other orders", () => {
  const receipt = create(proto.ReceiptSchema, {
    actionId: 201n,
    kind: {
      case: "tradeOrPlace",
      value: {
        posted: { orderId: 9007199254740993n, size: 100000n },
        orderUpdates: [
          {
            orderId: 9007199254740994n,
            remainingSize: 0n,
            cancelledSize: 200000n,
            reason: proto.Receipt_OrderUpdate_Reason.SELF_TRADE_PREVENTION,
          },
        ],
        fills: [],
      },
    },
  });
  const result = clobResult(
    serializable(receipt),
    { ...order, type: "limit", limitPrice: "50000", slippageBps: undefined },
    1,
    5,
  );
  assert.equal(result.orderId, "9007199254740993");
  assert.equal(result.restingBaseSize, "1");
});

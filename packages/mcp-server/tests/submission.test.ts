import test from "node:test";
import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import { sizeDelimitedEncode } from "@bufbuild/protobuf/wire";
import { NordSession, createAction } from "../src/nord/session";
import { sendAction, NordSubmissionError } from "../src/nord/submission";
import { proto } from "@n1xyz/nord-ts";

test("transport failures after signing are unknown, local signing failures are not submitted", async () => {
  const action = createAction(1n, 1, {
    case: "selfRevokeSession",
    value: create(proto.Action_SelfRevokeSessionSchema, { sessionId: 1n }),
  });
  let sends = 0;
  const client = {
    post: async () => {
      sends++;
      throw new Error("SECRET must never leak");
    },
  } as unknown as Parameters<typeof sendAction>[0];
  await assert.rejects(
    sendAction(
      client,
      async () => {
        throw new Error("private key");
      },
      action,
    ),
    (e: unknown) =>
      e instanceof NordSubmissionError && e.outcome === "not_submitted",
  );
  assert.equal(sends, 0);
  await assert.rejects(
    sendAction(client, async () => new Uint8Array(64), action),
    (e: unknown) =>
      e instanceof NordSubmissionError &&
      e.outcome === "unknown" &&
      !e.message.includes("SECRET"),
  );
  assert.equal(sends, 1);
});
test("session-only hooks persist identity before signing and receipt before return", async () => {
  const events: string[] = [];
  const receipt = create(proto.ReceiptSchema, {
    actionId: 9007199254740993n,
    kind: { case: "selfSessionRevoked", value: {} },
  });
  const options = {
    markets: [],
    getTimestamp: async () => 100n,
    transport: {
      post: async () => {
        events.push("send");
        return new Response(
          new Uint8Array(
            sizeDelimitedEncode(proto.ReceiptSchema, receipt),
          ).buffer,
        );
      },
    },
  };
  const user = new NordSession({
    ...options,
    sessionId: 1n,
    initialNonce: 7,
    signSessionFn: async () => {
      events.push("sign");
      return new Uint8Array(64);
    },
    hooks: {
      beforeSubmit: async (identity) => {
        events.push("journal");
        assert.equal(identity.nonce, 8);
        assert.equal(identity.hash.length, 64);
      },
      afterReceipt: async (r) => {
        events.push("receipt");
        assert.equal(r.actionId, 9007199254740993n);
      },
    },
  });
  await user.selfRevoke();
  assert.deepEqual(events, ["journal", "sign", "send", "receipt"]);
  assert.equal("refreshSession" in user, false); // No owner authorization capability.
});
test("journal failure prevents a session-only action from leaving the process", async () => {
  let sends = 0;
  const options = {
    markets: [],
    getTimestamp: async () => 1n,
    transport: {
      post: async () => {
        sends++;
        throw new Error("unexpected transport");
      },
    },
  };
  const user = new NordSession({
    ...options,
    sessionId: 1n,
    signSessionFn: async () => new Uint8Array(64),
    hooks: {
      beforeSubmit: async () => {
        throw new Error("disk full");
      },
      afterReceipt: async () => {},
    },
  });
  await assert.rejects(user.selfRevoke());
  assert.equal(sends, 0);
});

test("explicit protocol rejection is distinct from a duplicate with unknown prior outcome", async () => {
  const action = createAction(1n, 1, {
    case: "selfRevokeSession",
    value: create(proto.Action_SelfRevokeSessionSchema, { sessionId: 1n }),
  });
  for (const code of [
    proto.Error.DUPLICATE,
    proto.Error.NOT_SUPPORTED_INPUT,
    60000,
  ]) {
    const receipt = create(proto.ReceiptSchema, {
      actionId: 7n,
      kind: { case: "err", value: code },
    });
    const client = {
      post: async () =>
        new Response(
          new Uint8Array(
            sizeDelimitedEncode(proto.ReceiptSchema, receipt),
          ).buffer,
        ),
    } as unknown as Parameters<typeof sendAction>[0];
    await assert.rejects(
      sendAction(client, async () => new Uint8Array(64), action),
      (error: unknown) =>
        error instanceof NordSubmissionError &&
        error.outcome ===
          (code === proto.Error.NOT_SUPPORTED_INPUT ? "rejected" : "unknown"),
    );
  }
});

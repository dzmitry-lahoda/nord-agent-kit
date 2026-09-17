import test from "node:test";
import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import { sizeDelimitedEncode } from "@bufbuild/protobuf/wire";
import { Keypair } from "@solana/web3.js";
import { signAsync, verifyAsync } from "@noble/ed25519";
import {
  NordUser,
  Side,
  FillMode,
  proto,
  decodeLengthDelimited,
  type Nord,
} from "@n1xyz/nord-ts";
import { NordSession, authorizeSession } from "../src/nord/session";
import {
  actionTransport,
  NordSubmissionError,
  type ActionTransport,
} from "../src/nord/submission";

const timestamp = 1700000000n;
const markets = [{ marketId: 0, priceDecimals: 1, sizeDecimals: 5 }];
const noHooks = { beforeSubmit: async () => {}, afterReceipt: async () => {} };
function receiptResponse() {
  // The wire comparison deliberately stops at receipt normalization: the same
  // successful-but-unexpected receipt lets each caller finish transmission.
  return new Response(
    new Uint8Array(
      sizeDelimitedEncode(
        proto.ReceiptSchema,
        create(proto.ReceiptSchema, {
          actionId: 10n,
          kind: { case: "selfSessionRevoked", value: {} },
        }),
      ),
    ).buffer,
  );
}
async function clients() {
  const key = Keypair.fromSeed(new Uint8Array(32).fill(7));
  const sdkBodies: Uint8Array[] = [],
    adapterBodies: Uint8Array[] = [];
  const signSessionFn = (bytes: Uint8Array) =>
    signAsync(bytes, key.secretKey.slice(0, 32));
  const sdk = await NordUser.new({
    nord: {
      tokens: [],
      markets,
      getTimestamp: async () => timestamp,
      httpClient: {
        POST: async (_path: string, options: { body: Uint8Array }) => {
          sdkBodies.push(options.body);
          return { response: receiptResponse() };
        },
      },
    } as unknown as Nord,
    walletPubkey: key.publicKey,
    sessionPubkey: key.publicKey.toBytes(),
    sessionId: 42n,
    signSessionFn,
    signMessageFn: async () => {
      throw new Error("Owner unavailable");
    },
    signTransactionFn: async () => {
      throw new Error("Owner unavailable");
    },
  });
  const adapter = new NordSession({
    markets,
    getTimestamp: async () => timestamp,
    sessionId: 42n,
    signSessionFn,
    hooks: noHooks,
    transport: {
      post: async (body) => {
        adapterBodies.push(body);
        return receiptResponse();
      },
    },
  });
  return { sdk, adapter, sdkBodies, adapterBodies };
}
async function parity(
  run: (client: NordUser | NordSession) => Promise<unknown>,
) {
  const { sdk, adapter, sdkBodies, adapterBodies } = await clients();
  await run(sdk).catch(() => {});
  await run(adapter).catch(() => {});
  assert.equal(sdkBodies.length, 1, "SDK must transmit exactly once");
  assert.equal(adapterBodies.length, 1, "adapter must transmit exactly once");
  assert.deepEqual(
    adapterBodies[0],
    sdkBodies[0],
    "signed wire action must equal the unchanged SDK",
  );
}
for (const side of [Side.Bid, Side.Ask]) {
  for (const fillMode of [FillMode.ImmediateOrCancel, FillMode.Limit]) {
    for (const sizing of ["base", "quote"] as const) {
      test(`adapter CLOB bytes match unchanged SDK: ${side}, ${fillMode}, ${sizing}`, async () => {
        await parity((client) =>
          client.placeOrder({
            marketId: 0,
            accountId: 7,
            side,
            fillMode,
            price: "100.1",
            ...(sizing === "base"
              ? { size: "1.12345" }
              : { quoteSize: "112.457345" }),
            clientOrderId: "9007199254740997",
            isReduceOnly: true,
            selfTradePrevention: "expireMaker",
          }),
        );
      });
    }
  }
  test(`adapter user RFQ bytes match unchanged SDK: ${side}`, async () => {
    await parity((client) =>
      client.placeRfqOrder({
        marketId: 0,
        accountId: 7,
        side,
        price: "100.1",
        size: "1.12345",
        clientOrderId: "9007199254740997",
        isReduceOnly: true,
      }),
    );
  });
}
test("adapter cancellation, renewal and revocation bytes match unchanged SDK", async () => {
  await parity((client) => client.cancelOrder("9007199254740993", 7));
  await parity((client) => client.selfRefreshSession(timestamp + 86400n));
  await parity((client) => client.selfRevoke());
});

test("owner authorization uses portable exact hex framing and a separate Ed25519 owner signature", async () => {
  const owner = Keypair.fromSeed(new Uint8Array(32).fill(8));
  const session = Keypair.fromSeed(new Uint8Array(32).fill(9));
  let transmitted: Uint8Array | undefined;
  let approved: Uint8Array | undefined;
  await authorizeSession({
    owner: owner.publicKey.toBase58(),
    sessionPublicKey: session.publicKey.toBase58(),
    timestamp,
    expiry: timestamp + 86400n,
    deadline: timestamp + 7n * 86400n,
    transport: {
      post: async (body) => {
        transmitted = body;
        return receiptResponse();
      },
    },
    signMessage: async (message) => {
      approved = message;
      return signAsync(message, owner.secretKey.slice(0, 32));
    },
  });
  assert.ok(transmitted && approved);
  const payload = transmitted.slice(0, -64);
  assert.equal(
    new TextDecoder().decode(approved),
    Buffer.from(payload).toString("hex"),
  );
  assert.equal(
    await verifyAsync(
      transmitted.slice(-64),
      approved,
      owner.publicKey.toBytes(),
    ),
    true,
  );
  const action = decodeLengthDelimited(payload, proto.ActionSchema);
  assert.equal(action.nonce, 1);
  assert.equal(action.currentTimestamp, timestamp);
  assert.equal(action.kind.case, "createSession");
  if (action.kind.case !== "createSession")
    throw new Error("Wrong authorization action");
  assert.deepEqual(action.kind.value.userPubkey, owner.publicKey.toBytes());
  assert.deepEqual(
    action.kind.value.sessionPubkey,
    session.publicKey.toBytes(),
  );
  assert.equal(action.kind.value.expiryTimestamp, timestamp + 86400n);
  assert.equal(action.kind.value.refreshDeadline, timestamp + 7n * 86400n);
  assert.equal(action.kind.value.signatureFraming, undefined); // Omitted framing means legacy hex, matching the SDK.
});

test("rejected owner approval never reaches transport and cannot authorize an invalid deadline", async () => {
  const owner = Keypair.generate().publicKey.toBase58();
  let sends = 0;
  const options = {
    owner,
    sessionPublicKey: owner,
    timestamp,
    expiry: timestamp + 86400n,
    deadline: timestamp + 86400n,
    transport: {
      post: async () => {
        sends++;
        return receiptResponse();
      },
    },
    signMessage: async () => {
      throw new Error("wallet denied");
    },
  };
  await assert.rejects(
    authorizeSession(options),
    (e) => e instanceof NordSubmissionError && e.outcome === "not_submitted",
  );
  await assert.rejects(authorizeSession({ ...options, deadline: timestamp }));
  assert.equal(sends, 0);
});

test("adapter transport sends binary payload with a deadline and rejects redirects", async () => {
  const fakeFetch = (async (url: URL, options: RequestInit) => {
    assert.equal(url.toString(), "https://fixture.invalid/action");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    assert.equal(options.signal.aborted, false);
    assert.deepEqual(options.headers, {
      "content-type": "application/octet-stream",
    });
    assert.deepEqual(
      new Uint8Array(options.body as ArrayBuffer),
      new Uint8Array([1, 2, 3]),
    );
    return new Response();
  }) as typeof fetch;
  const transport: ActionTransport = actionTransport(
    "https://fixture.invalid",
    fakeFetch,
  );
  await transport.post(new Uint8Array([1, 2, 3]));
});

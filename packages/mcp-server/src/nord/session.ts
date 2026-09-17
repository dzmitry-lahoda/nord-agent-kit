import { create } from "@bufbuild/protobuf";
import {
  proto,
  Side,
  FillMode,
  fillModeToProtoFillMode,
  selfTradePreventionToProto,
  toScaledU64,
  toScaledU128,
  toU128Parts,
} from "@n1xyz/nord-ts";
import { PublicKey } from "@solana/web3.js";
import {
  sendAction,
  identifyAction,
  type ActionTransport,
  type SessionSubmissionHooks,
} from "./submission";

// Protocol adapter boundary; see ../../docs/nord-adapter.md for module responsibilities.
// Deliberately independent of tools, profiles, credentials and the request journal.
export type MarketPrecision = {
  marketId: number;
  priceDecimals: number;
  sizeDecimals: number;
};
type SessionOptions = {
  transport: ActionTransport;
  getTimestamp: () => Promise<bigint>;
  markets: MarketPrecision[];
  sessionId: bigint;
  initialNonce?: number;
  signSessionFn: (payload: Uint8Array) => Promise<Uint8Array>;
  hooks: SessionSubmissionHooks;
};
type Order = {
  marketId: number;
  accountId: number;
  side: Side;
  price: string;
  size?: string;
  clientOrderId: string;
  isReduceOnly?: boolean;
};
export function createAction(
  currentTimestamp: bigint,
  nonce: number,
  kind: proto.Action["kind"],
) {
  return create(proto.ActionSchema, { currentTimestamp, nonce, kind });
}
export class NordSession {
  private nonce: number;
  readonly markets: MarketPrecision[];
  constructor(private readonly options: SessionOptions) {
    const nonce = options.initialNonce ?? 0;
    if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce >= 0xffffffff)
      throw new Error("Invalid session nonce");
    if (options.sessionId <= 0n || options.sessionId > 0xffffffffffffffffn)
      throw new Error("Invalid session ID");
    this.nonce = nonce;
    this.markets = options.markets;
  }
  private market(id: number) {
    const market = this.markets.find((m) => m.marketId === id);
    if (!market) throw new Error("Unknown market");
    return market;
  }
  private async submit(build: (timestamp: bigint) => proto.Action["kind"]) {
    if (this.nonce >= 0xffffffff)
      throw new Error("Session nonce exhausted; authorize another session");
    const nonce = ++this.nonce;
    const timestamp = await this.options.getTimestamp();
    const action = createAction(timestamp, nonce, build(timestamp));
    await this.options.hooks.beforeSubmit(identifyAction(action));
    const receipt = await sendAction(
      this.options.transport,
      this.options.signSessionFn,
      action,
    );
    await this.options.hooks.afterReceipt(receipt);
    return receipt;
  }
  async placeOrder(
    input: Order & {
      quoteSize?: string;
      fillMode: FillMode;
      selfTradePrevention: "expireMaker";
    },
  ) {
    const market = this.market(input.marketId);
    const quote =
      input.quoteSize === undefined
        ? undefined
        : toScaledU128(
            input.quoteSize,
            market.priceDecimals + market.sizeDecimals,
          );
    return this.submit(() => ({
      case: "placeOrder",
      value: create(proto.Action_PlaceOrderSchema, {
        sessionId: this.options.sessionId,
        senderAccountId: input.accountId,
        marketId: input.marketId,
        side: input.side === Side.Bid ? proto.Side.BID : proto.Side.ASK,
        fillMode: fillModeToProtoFillMode(input.fillMode),
        isReduceOnly: input.isReduceOnly,
        price: toScaledU64(input.price, market.priceDecimals),
        size: toScaledU64(input.size ?? 0, market.sizeDecimals),
        quoteSize:
          quote === undefined
            ? undefined
            : create(proto.U128Schema, toU128Parts(quote)),
        selfTradePrevention: selfTradePreventionToProto(
          input.selfTradePrevention,
        ),
        clientOrderId: BigInt(input.clientOrderId),
      }),
    }));
  }
  async placeRfqOrder(input: Order & { size: string }) {
    const market = this.market(input.marketId);
    const receipt = await this.submit((timestamp) => ({
      case: "atomic",
      value: create(proto.AtomicSchema, {
        sessionId: this.options.sessionId,
        accountId: input.accountId,
        actions: [
          create(proto.AtomicSubactionSchema, {
            inner: {
              case: "rfqPlaceOnly",
              value: create(proto.RfqPlaceOnlySchema, {
                marketId: input.marketId,
                side: input.side === Side.Bid ? proto.Side.BID : proto.Side.ASK,
                price: toScaledU64(input.price, market.priceDecimals),
                size: toScaledU64(input.size, market.sizeDecimals),
                timestampMillis: timestamp * 1000n,
                clientOrderId: BigInt(input.clientOrderId),
                isReduceOnly: input.isReduceOnly,
                // Omitted timeout retains Nord's native default request timeout.
              }),
            },
          }),
        ],
      }),
    }));
    const result =
      receipt.kind.case === "atomic"
        ? receipt.kind.value.results[0]?.inner
        : undefined;
    if (result?.case !== "rfqResult")
      throw new Error("RFQ placement did not return an RFQ result");
    return { actionId: receipt.actionId, orderId: result.value.orderId };
  }
  async cancelOrder(orderId: string, accountId: number) {
    const receipt = await this.submit(() => ({
      case: "cancelOrderById",
      value: create(proto.Action_CancelOrderByIdSchema, {
        orderId: BigInt(orderId),
        sessionId: this.options.sessionId,
        senderAccountId: accountId,
      }),
    }));
    if (receipt.kind.case !== "cancelOrderResult")
      throw new Error("Unexpected cancellation receipt");
    return { actionId: receipt.actionId, ...receipt.kind.value };
  }
  async selfRefreshSession(expiry: bigint) {
    const receipt = await this.submit(() => ({
      case: "refreshSession",
      value: create(proto.Action_RefreshSessionSchema, {
        sessionId: this.options.sessionId,
        expiry,
      }),
    }));
    if (receipt.kind.case !== "sessionRefreshed")
      throw new Error("Unexpected renewal receipt");
    return { actionId: receipt.actionId, newExpiry: receipt.kind.value.expiry };
  }
  async selfRevoke() {
    const receipt = await this.submit(() => ({
      case: "selfRevokeSession",
      value: create(proto.Action_SelfRevokeSessionSchema, {
        sessionId: this.options.sessionId,
      }),
    }));
    if (receipt.kind.case !== "selfSessionRevoked")
      throw new Error("Unexpected revocation receipt");
    return { actionId: receipt.actionId };
  }
}

/** Owner authorization is separate from session-only execution and never retained by it. */
export async function authorizeSession(options: {
  transport: ActionTransport;
  timestamp: bigint;
  owner: string;
  sessionPublicKey: string;
  expiry: bigint;
  deadline: bigint;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}) {
  if (options.expiry <= options.timestamp || options.deadline < options.expiry)
    throw new Error("Invalid session authorization deadline");
  const action = createAction(options.timestamp, 1, {
    case: "createSession",
    value: create(proto.Action_CreateSessionSchema, {
      userPubkey: new PublicKey(options.owner).toBytes(),
      sessionPubkey: new PublicKey(options.sessionPublicKey).toBytes(),
      expiryTimestamp: options.expiry,
      refreshDeadline: options.deadline,
    }),
  });
  return sendAction(
    options.transport,
    (payload) =>
      options.signMessage(
        new TextEncoder().encode(Buffer.from(payload).toString("hex")),
      ),
    action,
  );
}

import { NordSession } from "./nord/session";
import { NordSubmissionError, actionTransport } from "./nord/submission";
import { prepareOrderQuantities, rfqReference } from "./order-preparation";
import { FillMode, Side } from "@n1xyz/nord-ts";
import { Keypair } from "@solana/web3.js";
import { signAsync } from "@noble/ed25519";
import Decimal from "decimal.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { Profiles, credentials } from "./storage";
import { Journal, type RequestRecord } from "./journal";
import { NordReads, object, safeNumber, type Market } from "./nord/reads";
import { fail, McpFailure, publicError } from "./errors";
import { clobResult } from "./receipts";
import { id, orderSchema, type OrderInput, type Profile } from "./model";

export function serializable(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    )
      fail(
        "INVALID_PROVIDER_DATA",
        "An unsafe numeric value cannot be represented.",
      );
    return String(value);
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k, v]) => k !== "$typeName" && v !== undefined)
        .map(([k, v]) => [k, serializable(v)]),
    );
  return value;
}
function submissionFailure(error: unknown): NordSubmissionError | undefined {
  let current = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
    if (current instanceof NordSubmissionError) return current;
    current = current.cause;
  }
  return undefined;
}
const accountSchema = z.object({
  orders: z.array(object),
  positions: z.array(object),
  balances: z.array(object),
  margins: object,
  updateId: id,
});
const historySchema = z.object({
  items: z.array(object),
  nextStartInclusive: id.nullish(),
});
const D = Decimal.clone({ precision: 100 });
export function localPage(
  items: Record<string, unknown>[],
  limit: number,
  cursor: string | undefined,
  key: string,
) {
  const sorted = [...items].sort((a, b) =>
    BigInt(id.parse(a[key])) < BigInt(id.parse(b[key])) ? -1 : 1,
  );
  const filtered =
    cursor === undefined
      ? sorted
      : sorted.filter((x) => BigInt(id.parse(x[key])) > BigInt(cursor));
  const page = filtered.slice(0, limit);
  return {
    items: page,
    nextCursor: filtered.length > limit ? id.parse(page.at(-1)?.[key]) : null,
    pagination: "local-keyset-live-snapshot",
  };
}

export class Runtime {
  readonly journal: Journal;
  readonly reads: NordReads;
  private user?: NordSession;
  private activeRequest?: string;
  private tail: Promise<unknown> = Promise.resolve();
  private renewalTimer?: ReturnType<typeof setInterval>;
  constructor(
    readonly profiles: Profiles,
    public profile: Profile,
    reads?: NordReads,
    private persistProfile = true,
  ) {
    this.reads = reads ?? new NordReads(profile.network);
    this.journal = new Journal(profiles, profile.name);
  }
  serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
  async close(): Promise<void> {
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    await this.tail;
    this.journal.close();
    this.user = undefined;
  }
  startRenewal(): void {
    this.renewalTimer = setInterval(
      () =>
        void this.serialize(() => this.renew()).catch(() =>
          process.stderr.write(
            "Session renewal needs attention; run nord-mcp status.\n",
          ),
        ),
      3600000,
    );
    this.renewalTimer.unref();
  }
  async connection() {
    const session = await this.reads.session(this.profile);
    const now = await this.reads.timestamp();
    return {
      profile: this.profile.name,
      network: this.profile.network,
      owner: this.profile.owner,
      accountId: this.profile.accountId,
      sessionId: this.profile.sessionId,
      sessionPublicKey: this.profile.sessionPublicKey,
      expiry: String(session.expiry),
      deadline: String(session.deadline),
      ready: this.profile.state === "active" && session.expiry > now,
      authority:
        "Nord session authority exceeds the trading tools exposed by this package.",
    };
  }
  private async ready(): Promise<void> {
    if (this.profile.state !== "active")
      fail("SESSION_REVOKED", "This profile is not active. Run setup.");
    const session = await this.reads.session(this.profile);
    if (session.expiry <= (await this.reads.timestamp()))
      fail(
        "SESSION_EXPIRED",
        "Session expired. Authorize a new session with nord-mcp setup.",
      );
    this.profile = { ...this.profile, ...session };
    if (this.persistProfile) this.profiles.save(this.profile);
  }
  private async signer(): Promise<NordSession> {
    if (this.user) return this.user;
    await this.reads.validateNetwork();
    const store = await credentials(this.profiles, this.profile.storage);
    const key = await store.get(this.profile.credentialId);
    const session = Keypair.fromSecretKey(key);
    if (session.publicKey.toBase58() !== this.profile.sessionPublicKey)
      fail(
        "CREDENTIAL_MISMATCH",
        "Stored key does not match the authorized session.",
      );
    this.user = new NordSession({
      transport: actionTransport(this.reads.config.nord),
      getTimestamp: async () => BigInt(await this.reads.timestamp()),
      markets: (await this.reads.markets()).map((m) => ({
        marketId: safeNumber(m.marketId),
        priceDecimals: safeNumber(m.priceDecimals),
        sizeDecimals: safeNumber(m.sizeDecimals),
      })),
      sessionId: BigInt(this.profile.sessionId!),
      initialNonce: this.journal.nonce(),
      signSessionFn: (bytes) => signAsync(bytes, key.slice(0, 32)),
      hooks: {
        beforeSubmit: async (action) => {
          if (!this.activeRequest)
            fail(
              "UNJOURNALED_ACTION",
              "A session action must have a durable request record.",
            );
          this.journal.beforeSend(this.activeRequest, action);
        },
        afterReceipt: async (receipt) => {
          if (!this.activeRequest)
            fail("UNJOURNALED_ACTION", "Missing receipt journal context.");
          this.journal.receipt(
            this.activeRequest,
            receipt.actionId.toString(),
            serializable(receipt),
          );
        },
      },
    });
    return this.user;
  }
  async account() {
    await this.reads.verifyOwner(this.profile);
    return accountSchema.parse(
      await this.reads.get(`/account/${this.profile.accountId}`),
    );
  }
  async market(marketId: string) {
    return this.reads.market(marketId);
  }
  async order(orderId: string, limit = 20, cursor?: string) {
    const order = object.parse(await this.reads.get(`/order/${orderId}`));
    if (order.traderId !== this.profile.accountId)
      fail("ACCOUNT_MISMATCH", "This order belongs to another account.");
    const fills = historySchema.parse(
      await this.reads.get(`/order/${orderId}/trades`, {
        pageSize: limit,
        startInclusive: cursor,
      }),
    );
    return {
      order,
      fills: fills.items,
      nextCursor: fills.nextStartInclusive ?? null,
    };
  }
  async history(limit: number, cursor?: string) {
    await this.reads.verifyOwner(this.profile);
    const page = historySchema.parse(
      await this.reads.get(`/account/${this.profile.accountId}/orders`, {
        pageSize: limit,
        startInclusive: cursor,
      }),
    );
    return { items: page.items, nextCursor: page.nextStartInclusive ?? null };
  }
  async prepare(input: OrderInput) {
    orderSchema.parse(input);
    await this.ready();
    const { market, live, observedAt } = await this.market(input.marketId);
    const account = await this.account();
    if (live.frozen === true || market.regime === "frozen")
      fail("MARKET_FROZEN", "Market is frozen; trading is unavailable.");
    if (market.regime !== "normal")
      fail(
        "UNSUPPORTED_MARKET_OPERATION",
        "This market regime is not supported by v1.",
      );
    if (market.mode !== "clob" && market.mode !== "rfq")
      fail(
        "UNSUPPORTED_MARKET_OPERATION",
        "Unrecognized market execution mode.",
      );
    if (market.mode === "rfq" && input.type === "limit")
      fail(
        "UNSUPPORTED_MARKET_OPERATION",
        "RFQ markets only accept market-style placement.",
      );
    let referencePrice: string | undefined;
    if (input.type === "market") {
      if (market.mode === "rfq") {
        const rfq = z
          .object({
            physicalTime: z.string(),
            sampledBidPrice: z.string(),
            sampledAskPrice: z.string(),
            indexPriceAtSampleTime: z.string(),
          })
          .safeParse(live.rfq);
        if (!rfq.success || typeof live.indexPrice !== "string")
          fail(
            "STALE_PRICING",
            "A complete finalized RFQ sample and current index are required. Retry after pricing refreshes.",
          );
        try {
          referencePrice = rfqReference({
            bid: rfq.data.sampledBidPrice,
            ask: rfq.data.sampledAskPrice,
            sampledIndex: rfq.data.indexPriceAtSampleTime,
            currentIndex: live.indexPrice,
            sampledAtMs: Date.parse(rfq.data.physicalTime),
            indexObservedAtMs: observedAt,
            nowMs: Date.now(),
          });
        } catch {
          fail(
            "STALE_PRICING",
            "RFQ sample is incomplete, invalid, or stale. Retry after pricing refreshes.",
          );
        }
      } else {
        const book = z
          .object({
            asks: z.array(z.tuple([z.string(), z.string()])),
            bids: z.array(z.tuple([z.string(), z.string()])),
          })
          .parse(await this.reads.get(`/market/${input.marketId}/orderbook`));
        const levels = input.side === "buy" ? book.asks : book.bids;
        const prices = levels
          .filter(([, size]) => new D(size).gt(0))
          .map(([price]) => new D(price));
        if (!prices.length)
          fail(
            "STALE_PRICING",
            "No executable CLOB liquidity is available on this side.",
          );
        referencePrice = (
          input.side === "buy" ? D.min(...prices) : D.max(...prices)
        ).toFixed();
      }
    }
    let quantities;
    try {
      quantities = prepareOrderQuantities(input, {
        mode: market.mode,
        priceDecimals: safeNumber(market.priceDecimals),
        sizeDecimals: safeNumber(market.sizeDecimals),
        referencePrice,
      });
    } catch {
      return fail(
        "INVALID_ARGUMENTS",
        "Order precision, price, or size is invalid for this market. Inspect nord_get_market.",
      );
    }
    return {
      market,
      accountUpdateId: account.updateId,
      ...quantities,
      referencePrice: referencePrice ?? null,
      observedAt,
      indicative: true,
      quoteSizing:
        market.mode === "rfq" && input.quoteNotional !== undefined
          ? "notional-target-not-native-quote-cap"
          : "native",
      reduceOnly: input.reduceOnly,
    };
  }
  private identity(): string {
    return `${this.profile.network}:${this.profile.owner}:${this.profile.accountId}`;
  }
  private async execute(
    requestId: string,
    kind: RequestRecord["kind"],
    args: Record<string, unknown>,
    send: (user: NordSession, record: RequestRecord) => Promise<unknown>,
  ) {
    const existing = this.journal.get(requestId);
    const cursor =
      existing?.cursor ??
      id.parse(await this.reads.get("/action/last-executed-id"));
    const { record, fresh } = this.journal.begin(
      requestId,
      this.identity(),
      kind,
      args,
      cursor,
    );
    // Only this pre-send crash window proves that no action left the process.
    // Once an action identity exists, retries must reconcile instead of sending.
    if (!fresh && (record.state !== "prepared" || record.action))
      return this.reconcile(record.id);
    this.activeRequest = requestId;
    try {
      const user = await this.signer();
      const result = await send(user, record);
      const latest = this.journal.get(requestId)!;
      this.journal.save({ ...latest, result: serializable(result) });
      return this.journal.get(requestId)!;
    } catch (error) {
      const latest = this.journal.get(requestId)!;
      if (latest.state === "accepted") return latest; // Receipt is authoritative even if normalization fails.
      const failure = submissionFailure(error);
      const state =
        failure?.outcome ?? (latest.action ? "unknown" : "not_submitted");
      const details = failure
        ? {
            code:
              state === "unknown"
                ? "UNKNOWN_EXECUTION_OUTCOME"
                : failure.protocolCode?.includes("MARGIN")
                  ? "INSUFFICIENT_MARGIN"
                  : "PROTOCOL_REJECTION",
            message:
              state === "unknown"
                ? "Outcome unknown. Inspect this request; do not place a replacement."
                : `Nord ${state}. ${failure.protocolCode ?? "Inspect arguments and session readiness."}`,
          }
        : publicError(error);
      this.journal.save({ ...latest, state, error: details });
      return this.journal.get(requestId)!;
    } finally {
      this.activeRequest = undefined;
    }
  }
  async place(requestId: string, input: OrderInput) {
    // Duplicate requests must be inspectable even if the session has since expired.
    if (!this.journal.get(requestId)) await this.prepare(input);
    return this.execute(requestId, "place", input, async (user, record) => {
      const prepared = await this.prepare(input);
      // Metadata used by protocol scaling must match the fresh preparation snapshot.
      const signingMarket = user.markets.find(
        (m) => String(m.marketId) === input.marketId,
      );
      if (
        !signingMarket ||
        signingMarket.priceDecimals !==
          safeNumber(prepared.market.priceDecimals) ||
        signingMarket.sizeDecimals !==
          safeNumber(prepared.market.sizeDecimals) ||
        Date.now() - prepared.observedAt > 10000
      )
        fail(
          "STALE_PRICING",
          "Market preparation expired or metadata changed. Use a new request after inspecting this one.",
        );
      const common = {
        marketId: safeNumber(input.marketId),
        accountId: safeNumber(this.profile.accountId),
        side: input.side === "buy" ? Side.Bid : Side.Ask,
        price: prepared.price,
        size: prepared.size,
        clientOrderId: record.clientOrderId,
        isReduceOnly: input.reduceOnly,
      };
      if (prepared.market.mode === "rfq") {
        const result = await user.placeRfqOrder({
          ...common,
          size: prepared.size!,
        });
        return {
          ...result,
          status: "placement-acknowledged",
          fillStatus: "unknown",
          baseSize: prepared.size,
          protectionPrice: prepared.price,
        };
      }
      try {
        await user.placeOrder({
          ...common,
          quoteSize: prepared.quoteSize,
          fillMode:
            input.type === "market"
              ? FillMode.ImmediateOrCancel
              : FillMode.Limit,
          selfTradePrevention: "expireMaker",
        });
      } catch (error) {
        if (this.journal.get(requestId)?.state !== "accepted") throw error;
      }
      return clobResult(
        this.journal.get(requestId)!.receipt,
        input,
        safeNumber(prepared.market.priceDecimals),
        safeNumber(prepared.market.sizeDecimals),
      );
    });
  }
  private async prepareCancellation(orderId: string) {
    await this.ready();
    const liveOrder = (await this.account()).orders.find(
      (order) => order.orderId === orderId,
    );
    const mode = liveOrder
      ? (await this.market(id.parse(liveOrder.marketId))).market.mode
      : (await this.order(orderId, 1)).order.marketMode;
    if (mode !== "clob")
      fail(
        "UNSUPPORTED_MARKET_OPERATION",
        "RFQ cancellation is unsupported; an outstanding RFQ expires at its timeout.",
      );
  }
  async cancel(requestId: string, orderId: string) {
    if (!this.journal.get(requestId)) await this.prepareCancellation(orderId);
    return this.execute(requestId, "cancel", { orderId }, async (user) => {
      await this.prepareCancellation(orderId);
      return user.cancelOrder(orderId, safeNumber(this.profile.accountId));
    });
  }
  async reconcile(requestId: string): Promise<RequestRecord> {
    let record =
      this.journal.get(requestId) ??
      fail(
        "REQUEST_NOT_FOUND",
        "No request with this ID exists in this profile.",
      );
    if (record.state === "accepted") return this.reconcileOrder(record);
    if (!record.action || ["rejected", "not_submitted"].includes(record.state))
      return record;
    const latest = BigInt(
      id.parse(await this.reads.get("/action/last-executed-id")),
    );
    const from = BigInt(record.cursor),
      to = from + 49n < latest ? from + 49n : latest;
    if (from > to) return record;
    const actions = z
      .array(
        z.object({
          actionId: id,
          payload: z.string(),
          physicalTime: z.string(),
        }),
      )
      .parse(
        await this.reads.get("/action", {
          from: from.toString(),
          to: to.toString(),
        }),
      );
    const match = actions.find(
      (action) =>
        createHash("sha256")
          .update(Buffer.from(action.payload, "base64"))
          .digest("hex") === record.action!.hash,
    );
    if (match)
      record = {
        ...record,
        state: "accepted",
        actionId: match.actionId,
        acceptedAt: match.physicalTime,
        result: {
          status: "accepted-action",
          orderState: "unknown",
          receipt: null,
          nextStep:
            "Inspect account history and order fills; acceptance alone does not establish a fill.",
        },
      };
    else {
      // Do not advance over holes in a lagging history replica.
      const seen = new Set(actions.map((x) => x.actionId));
      let cursor = from;
      while (seen.has(cursor.toString()) && cursor <= to) cursor++;
      record = { ...record, state: "unknown", cursor: cursor.toString() };
    }
    this.journal.save(record);
    return record.state === "accepted" ? this.reconcileOrder(record) : record;
  }
  private async reconcileOrder(record: RequestRecord): Promise<RequestRecord> {
    if (record.kind !== "place" && record.kind !== "cancel") return record;
    try {
      const result =
        record.result && typeof record.result === "object"
          ? (record.result as Record<string, unknown>)
          : {};
      let orderId =
        record.orderId ??
        (typeof result.orderId === "string" ? result.orderId : undefined) ??
        (record.kind === "cancel" ? String(record.args.orderId) : undefined);
      if (!orderId && record.acceptedAt) {
        const page = await this.history(50, record.historyCursor);
        const matches = page.items.filter(
          (o) =>
            o.clientOrderId === record.clientOrderId &&
            typeof o.addedAt === "string" &&
            Date.parse(o.addedAt) === Date.parse(record.acceptedAt!),
        );
        if (matches.length === 1) orderId = id.parse(matches[0]!.orderId);
        record = { ...record, historyCursor: page.nextCursor ?? undefined };
      }
      if (orderId)
        record = {
          ...record,
          orderId,
          orderLifecycle: await this.order(orderId, 20),
        };
      this.journal.save(record);
    } catch {
      /* Retain authoritative acceptance when order history is unavailable or lagging. */
    }
    return record;
  }
  async renew() {
    const remote = await this.reads.session(this.profile),
      now = await this.reads.timestamp();
    this.profile = { ...this.profile, ...remote };
    if (this.persistProfile) this.profiles.save(this.profile);
    if (remote.expiry <= now)
      fail("SESSION_EXPIRED", "Expired sessions cannot renew. Run setup.");
    if (remote.expiry - now >= 43200 || remote.expiry >= remote.deadline)
      return this.connection();
    const requestId = `renew:${this.profile.sessionId}:${remote.expiry}`;
    const target = Number(
      this.journal.get(requestId)?.args.expiry ??
        Math.min(now + 86400, remote.deadline),
    );
    await this.execute(requestId, "renew", { expiry: String(target) }, (user) =>
      user.selfRefreshSession(BigInt(target)),
    );
    const verified = await this.reads.session(this.profile);
    if (verified.expiry < target)
      fail(
        "UNKNOWN_EXECUTION_OUTCOME",
        "Renewal is not yet verified. Inspect the renewal request before retrying.",
      );
    this.profile = { ...this.profile, ...verified };
    if (this.persistProfile) this.profiles.save(this.profile);
    return this.connection();
  }
  async revoke() {
    const user = await this.reads.verifyOwner(this.profile);
    if (this.profile.sessionId && user.sessions[this.profile.sessionId]) {
      if (
        user.sessions[this.profile.sessionId]!.pubkey !==
        this.profile.sessionPublicKey
      )
        fail("SESSION_MISMATCH", "Refusing to revoke a mismatched session.");
      await this.execute(
        `revoke:${this.profile.sessionId}`,
        "revoke",
        {},
        (signer) => signer.selfRevoke(),
      );
      if (
        (await this.reads.user(this.profile.owner)).sessions[
          this.profile.sessionId
        ]
      )
        fail(
          "UNKNOWN_EXECUTION_OUTCOME",
          "Revocation has not been verified. Remote access may remain. Inspect the request and retry verification.",
        );
    }
    if (this.profile.predecessor) {
      const previous = {
        ...this.profile,
        ...this.profile.predecessor,
        predecessor: undefined,
      };
      const runtime = new Runtime(this.profiles, previous, undefined, false);
      try {
        await runtime.revoke();
        await (
          await credentials(this.profiles, previous.storage)
        ).delete(previous.credentialId);
        delete this.profile.predecessor;
      } finally {
        await runtime.close();
      }
    }
    this.profile = { ...this.profile, state: "revoked" };
    if (this.persistProfile) this.profiles.save(this.profile);
    return { revoked: true, outstandingOrders: "unchanged" };
  }
}

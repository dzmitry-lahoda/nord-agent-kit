import { z } from "zod";
import { id, positiveDecimal } from "./model";
const record = z.record(z.string(), z.json());
const page = z.object({
  items: z.array(record),
  nextCursor: id.nullable(),
  pagination: z.string().optional(),
});
const request = z
  .object({
    id: z.string(),
    identity: z.string(),
    kind: z.enum(["place", "cancel", "renew", "revoke"]),
    args: record,
    fingerprint: z.string(),
    clientOrderId: id,
    state: z.enum([
      "prepared",
      "submitting",
      "accepted",
      "rejected",
      "not_submitted",
      "unknown",
    ]),
    cursor: id,
    createdAt: z.string(),
  })
  .catchall(z.json());
export const outputs = {
  nord_get_connection: z.object({
    profile: z.string(),
    network: z.enum(["devnet", "mainnet"]),
    owner: z.string(),
    accountId: id,
    sessionId: id.optional(),
    sessionPublicKey: z.string(),
    expiry: id,
    deadline: id,
    ready: z.boolean(),
    authority: z.string(),
  }),
  nord_list_markets: page,
  nord_get_market: z.object({
    market: record,
    live: record,
    depth: record.nullable(),
    observedAt: z.string(),
    capabilities: z.object({
      limit: z.boolean(),
      cancel: z.boolean(),
      market: z.boolean(),
    }),
  }),
  nord_get_account: z.object({
    accountId: id,
    balances: z.array(record),
    risk: record,
    equity: z.null(),
    updateId: id,
  }),
  nord_list_positions: page,
  nord_list_open_orders: page,
  nord_list_order_history: page,
  nord_get_order: z.object({
    order: record,
    fills: z.array(record),
    nextCursor: id.nullable(),
  }),
  nord_preview_order: z.object({
    market: record,
    accountUpdateId: id,
    price: z.string(),
    size: z.string().optional(),
    quoteSize: z.string().optional(),
    referencePrice: positiveDecimal.nullable(),
    observedAt: id,
    indicative: z.literal(true),
    quoteSizing: z.enum(["native", "notional-target-not-native-quote-cap"]),
    reduceOnly: z.boolean(),
  }),
  nord_place_order: request,
  nord_cancel_order: request,
  nord_get_request: request,
} as const;
export function outputFor(name: keyof typeof outputs) {
  return z.object({
    ok: z.boolean(),
    data: outputs[name].optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  });
}

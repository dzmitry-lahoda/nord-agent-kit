import Decimal from "decimal.js";
import { z } from "zod";
import type { OrderInput } from "./model";
const D = Decimal.clone({ precision: 100 });
const tradeSchema = z.object({
  orderId: z.string(),
  price: z.string(),
  size: z.string(),
  accountId: z.string(),
});
/** Normalize from the journal's exact protocol integers, never the SDK's legacy floating-point result. */
export function clobResult(
  receipt: unknown,
  input: OrderInput,
  priceDecimals: number,
  sizeDecimals: number,
) {
  const raw = z
    .object({
      actionId: z.string(),
      kind: z.object({
        case: z.literal("tradeOrPlace"),
        value: z.object({
          fills: z.array(tradeSchema),
          posted: z
            .object({ orderId: z.string(), size: z.string() })
            .optional(),
        }),
      }),
    })
    .parse(receipt);
  const scalePrice = new D(10).pow(priceDecimals),
    scaleSize = new D(10).pow(sizeDecimals);
  const fills = raw.kind.value.fills.map((fill) => ({
    orderId: fill.orderId,
    accountId: fill.accountId,
    price: new D(fill.price).div(scalePrice).toFixed(),
    baseSize: new D(fill.size).div(scaleSize).toFixed(),
  }));
  const filledBase = fills.reduce(
    (sum, fill) => sum.add(fill.baseSize),
    new D(0),
  );
  const filledQuote = fills.reduce(
    (sum, fill) => sum.add(new D(fill.baseSize).mul(fill.price)),
    new D(0),
  );
  return {
    actionId: raw.actionId,
    orderId: raw.kind.value.posted?.orderId ?? null,
    status: "accepted",
    fills,
    filledBaseSize: filledBase.toFixed(),
    filledQuoteNotional: filledQuote.toFixed(),
    unfilledBaseSize: input.baseSize
      ? D.max(0, new D(input.baseSize).minus(filledBase)).toFixed()
      : null,
    unfilledQuoteNotional: input.quoteNotional
      ? D.max(0, new D(input.quoteNotional).minus(filledQuote)).toFixed()
      : null,
    restingBaseSize: raw.kind.value.posted
      ? new D(raw.kind.value.posted.size).div(scaleSize).toFixed()
      : "0",
    note: "Quote notional excludes fees. Unfilled quantity can rest only for limit orders; IOC remainder is not placed.",
  };
}

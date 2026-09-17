import Decimal from "decimal.js";

// Isolate precision from consumers that change Decimal's global configuration.
const D = Decimal.clone({ precision: 100 });
export type OrderPreparationInput = {
  side: "buy" | "sell";
  type: "market" | "limit";
  baseSize?: string;
  quoteNotional?: string;
  limitPrice?: string;
  slippageBps?: number;
};
export type PreparationMarket = {
  mode: "clob" | "rfq";
  priceDecimals: number;
  sizeDecimals: number;
  referencePrice?: string;
};

function positive(value: string): Decimal {
  const n = new D(value);
  if (!n.isFinite() || !n.gt(0))
    throw new Error("Expected a positive finite quantity");
  return n;
}
function exact(value: string, decimals: number, bits = 64): string {
  const n = positive(value);
  const scaled = n.mul(new D(10).pow(decimals));
  if (!scaled.isInteger() || scaled.gte(new D(2).pow(bits))) {
    throw new Error(
      "Quantity has invalid precision or exceeds the protocol range",
    );
  }
  return n.toFixed();
}

/** Pure quantity/protective-price preparation; callers establish market freshness and policy. */
export function prepareOrderQuantities(
  input: OrderPreparationInput,
  market: PreparationMarket,
) {
  for (const decimals of [market.priceDecimals, market.sizeDecimals]) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38)
      throw new Error("Invalid market precision");
  }
  if ((input.baseSize === undefined) === (input.quoteNotional === undefined))
    throw new Error("Specify exactly one size");
  if (market.mode === "rfq" && input.type !== "market")
    throw new Error("RFQ only supports market-style placement");
  let price: string;
  if (input.type === "limit") {
    if (!input.limitPrice || input.slippageBps !== undefined)
      throw new Error("Limit orders require an exact limit price");
    price = exact(input.limitPrice, market.priceDecimals);
  } else {
    if (
      input.limitPrice !== undefined ||
      input.slippageBps === undefined ||
      !Number.isInteger(input.slippageBps) ||
      input.slippageBps < 0 ||
      input.slippageBps >= 10000
    ) {
      throw new Error(
        "Market orders require slippage basis points in [0, 9999]",
      );
    }
    if (!market.referencePrice)
      throw new Error("A fresh executable reference is required");
    price = positive(market.referencePrice)
      .mul(
        new D(
          10000 +
            (input.side === "buy" ? input.slippageBps : -input.slippageBps),
        ).div(10000),
      )
      .toDecimalPlaces(
        market.priceDecimals,
        input.side === "buy" ? D.ROUND_FLOOR : D.ROUND_CEIL,
      )
      .toFixed();
    exact(price, market.priceDecimals);
  }
  let size =
    input.baseSize === undefined
      ? undefined
      : exact(input.baseSize, market.sizeDecimals);
  let quoteSize: string | undefined;
  if (input.quoteNotional !== undefined) {
    if (market.mode === "clob")
      quoteSize = exact(
        input.quoteNotional,
        market.priceDecimals + market.sizeDecimals,
        128,
      );
    else {
      if (!market.referencePrice)
        throw new Error("RFQ sizing requires a fresh reference");
      // Buy sizing uses the protective bound so its maximum price is accounted for.
      const denominator = input.side === "buy" ? price : market.referencePrice;
      size = positive(input.quoteNotional)
        .div(positive(denominator))
        .toDecimalPlaces(market.sizeDecimals, D.ROUND_FLOOR)
        .toFixed();
      exact(size, market.sizeDecimals);
    }
  }
  return { price, size, quoteSize };
}

/** Indicative RFQ mark anchored to finalized sampling and a newly observed index. */
export function rfqReference(input: {
  bid: string;
  ask: string;
  sampledIndex: string;
  currentIndex: string;
  sampledAtMs: number;
  indexObservedAtMs: number;
  nowMs: number;
}): string {
  const sampleAge = input.nowMs - input.sampledAtMs;
  const indexAge = input.nowMs - input.indexObservedAtMs;
  if (
    ![sampleAge, indexAge].every(Number.isFinite) ||
    sampleAge < 0 ||
    sampleAge > 30000 ||
    indexAge < 0 ||
    indexAge > 10000
  ) {
    throw new Error("Stale RFQ reference");
  }
  const bid = positive(input.bid),
    ask = positive(input.ask);
  if (bid.gt(ask)) throw new Error("Crossed RFQ sample");
  return bid
    .add(ask)
    .div(2)
    .div(positive(input.sampledIndex))
    .mul(positive(input.currentIndex))
    .toFixed();
}

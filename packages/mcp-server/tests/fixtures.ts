import { NordReads, type Market } from "../src/nord/reads";
import type { Profile } from "../src/model";
export const profile: Profile = {
  version: 1,
  name: "fixture",
  network: "devnet",
  owner: "11111111111111111111111111111111",
  accountId: "7",
  sessionPublicKey: "11111111111111111111111111111111",
  sessionId: "42",
  expiry: 1700086400,
  deadline: 1700604800,
  credentialId: "00000000-0000-4000-8000-000000000001",
  storage: "file",
  state: "active",
};
export const markets: Market[] = [
  {
    marketId: "0",
    symbol: "BTCUSD",
    priceDecimals: "1",
    sizeDecimals: "5",
    mode: "clob",
    regime: "normal",
  },
  {
    marketId: "2",
    symbol: "SOLUSD",
    priceDecimals: "2",
    sizeDecimals: "2",
    mode: "rfq",
    regime: "normal",
  },
];
export const orders = [
  {
    orderId: "9007199254740993",
    traderId: "7",
    marketId: "0",
    marketMode: "clob",
    placedSize: "2",
    filledSize: "1",
    finalizationReason: null,
    clientOrderId: "101",
  },
  {
    orderId: "9007199254740994",
    traderId: "7",
    marketId: "2",
    marketMode: "rfq",
    placedSize: "3",
    filledSize: "0",
    finalizationReason: "expired",
    clientOrderId: "102",
  },
];
export class FixtureReads extends NordReads {
  constructor() {
    super("devnet");
  }
  override async validateNetwork() {}
  override async timestamp() {
    return 1700000000;
  }
  override async markets() {
    return markets;
  }
  override async user() {
    return {
      accountIds: ["7"],
      sessions: {
        "42": {
          pubkey: profile.sessionPublicKey,
          expiry: new Date(profile.expiry * 1000).toISOString(),
          refreshDeadline: new Date(profile.deadline * 1000).toISOString(),
        },
      },
    };
  }
  override async get(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<unknown> {
    if (path === "/account/7/pubkey") return profile.owner;
    if (path === "/account/7")
      return {
        updateId: "18446744073709551614",
        balances: [{ tokenId: "0", token: "USD", amount: "1234.56789" }],
        margins: { mf: "100", bankruptcy: false },
        positions: [
          {
            marketId: "0",
            perp: { baseSize: "0.5", isLong: true, price: "50000" },
          },
          {
            marketId: "2",
            perp: { baseSize: "3", isLong: false, price: "100" },
          },
        ],
        orders: [
          {
            orderId: orders[0]!.orderId,
            marketId: "0",
            size: "1",
            price: "50000",
            side: "bid",
          },
        ],
      };
    if (path === "/account/7/orders")
      return query.startInclusive
        ? { items: [orders[1]], nextStartInclusive: null }
        : { items: [orders[0]], nextStartInclusive: orders[1]!.orderId };
    if (path.startsWith("/order/") && path.endsWith("/trades"))
      return {
        items: path.includes(orders[0]!.orderId)
          ? [{ tradeId: "500", actionId: "100", size: "1", price: "50000" }]
          : [],
        nextStartInclusive: null,
      };
    if (path.startsWith("/order/"))
      return orders.find((o) => path === `/order/${o.orderId}`);
    if (path.endsWith("/live"))
      return {
        marketId: path.split("/")[2],
        indexPrice: "100",
        frozen: false,
        rfq: {
          physicalTime: "2023-11-14T22:13:20Z",
          sampledBidPrice: "99",
          sampledAskPrice: "101",
          indexPriceAtSampleTime: "100",
        },
      };
    if (path.endsWith("/orderbook"))
      return { asks: [["50001", "1"]], bids: [["50000", "2"]] };
    if (path === "/action/last-executed-id") return "100";
    if (path === "/action") return [];
    throw new Error(`Missing fixture for ${path}`);
  }
}

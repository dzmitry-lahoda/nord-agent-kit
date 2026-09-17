import { Connection } from "@solana/web3.js";
import JSONbig from "json-bigint";
import { z } from "zod";
import { id, type Profile } from "../model";
import { fail, McpFailure } from "../errors";

export const NETWORKS = {
  devnet: {
    version: 1,
    nord: "https://zo-devnet.n1.xyz",
    solana: "https://api.devnet.solana.com",
    genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  },
  mainnet: {
    version: 1,
    nord: "https://zo-mainnet.n1.xyz",
    solana: "https://api.mainnet-beta.solana.com",
    genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  },
} as const;
const parser = JSONbig({
  alwaysParseAsBig: true,
  storeAsString: true,
  protoAction: "error",
  constructorAction: "error",
});
export function exactJson(text: string): unknown {
  return parser.parse(text, (_key: string, value: unknown) => {
    if (typeof value === "number") return String(value);
    if (
      value &&
      typeof value === "object" &&
      "toFixed" in value &&
      typeof value.toFixed === "function"
    )
      return value.toFixed();
    return value;
  });
}
export function safeNumber(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    fail(
      "UNSUPPORTED_IDENTIFIER",
      "The installed SDK cannot safely represent this identifier.",
    );
  return n;
}
export const object = z.record(z.string(), z.unknown());
export const userSchema = z.object({
  accountIds: z.array(id),
  sessions: z.record(
    id,
    z.object({
      pubkey: z.string(),
      expiry: z.string(),
      refreshDeadline: z.string().optional(),
    }),
  ),
});
export type RemoteUser = z.infer<typeof userSchema>;
export const marketSchema = z
  .object({
    marketId: id,
    symbol: z.string(),
    priceDecimals: id,
    sizeDecimals: id,
    mode: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();
export type Market = z.infer<typeof marketSchema>;

/** Lossless HTTP reads: JSON numbers become decimal strings before JavaScript can round them. */
export class NordReads {
  readonly config;
  constructor(
    readonly network: Profile["network"],
    private fetcher: typeof fetch = fetch,
  ) {
    this.config = NETWORKS[network];
  }
  async get(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<unknown> {
    const url = new URL(path, this.config.nord);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await this.fetcher(url, {
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok)
      fail(
        response.status === 404 ? "NOT_FOUND" : "PROVIDER_UNAVAILABLE",
        "Nord could not provide the requested state. Retry the read; inspect pending requests before retrying writes.",
      );
    const body = await response.text();
    if (body.length > 8 * 1024 * 1024)
      fail(
        "INVALID_PROVIDER_DATA",
        "Nord response exceeds the supported size.",
      );
    return exactJson(body);
  }
  async validateNetwork(): Promise<void> {
    const connection = new Connection(this.config.solana, {
      fetch: this.fetcher,
    });
    if ((await connection.getGenesisHash()) !== this.config.genesis)
      fail(
        "NETWORK_MISMATCH",
        "Solana genesis does not match the profile network.",
      );
  }
  async user(owner: string): Promise<RemoteUser> {
    try {
      return userSchema.parse(
        await this.get(`/user/${encodeURIComponent(owner)}`),
      );
    } catch (error) {
      if (error instanceof McpFailure && error.code === "NOT_FOUND")
        fail(
          "ACCOUNT_NOT_FOUND",
          "No Nord account exists for this wallet. Deposit collateral through Nord before running setup.",
        );
      throw error;
    }
  }
  async verifyOwner(
    profile: Pick<Profile, "owner" | "accountId">,
  ): Promise<RemoteUser> {
    const user = await this.user(profile.owner);
    if (
      !user.accountIds.includes(profile.accountId) ||
      (await this.get(`/account/${profile.accountId}/pubkey`)) !== profile.owner
    )
      fail(
        "OWNER_MISMATCH",
        "Nord account ownership does not match this profile. Run setup for the correct owner.",
      );
    return user;
  }
  async session(profile: Profile) {
    const user = await this.verifyOwner(profile);
    const session = profile.sessionId
      ? user.sessions[profile.sessionId]
      : undefined;
    if (!session || session.pubkey !== profile.sessionPublicKey)
      fail(
        "SESSION_REVOKED",
        "The authorized session is absent or mismatched. Run setup again.",
      );
    const expiry = Date.parse(session.expiry) / 1000,
      deadline = Date.parse(session.refreshDeadline ?? "") / 1000;
    if (
      !Number.isSafeInteger(expiry) ||
      !Number.isSafeInteger(deadline) ||
      deadline > profile.deadline
    )
      fail(
        "INVALID_PROVIDER_DATA",
        "Nord session deadlines cannot be verified.",
      );
    return { expiry, deadline };
  }
  async timestamp(): Promise<number> {
    return safeNumber(id.parse(await this.get("/timestamp")));
  }
  async market(marketId: string) {
    const market =
      (await this.markets()).find((m) => m.marketId === marketId) ??
      fail("MARKET_NOT_FOUND", "Use nord_list_markets to select a market ID.");
    const observedAt = Date.now();
    const live = object.parse(await this.get(`/market/${marketId}/live`));
    return { market, live, observedAt };
  }
  async markets(): Promise<Market[]> {
    return z
      .object({ markets: z.array(marketSchema) })
      .parse(await this.get("/info")).markets;
  }
}

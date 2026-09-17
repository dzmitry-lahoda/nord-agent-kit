# Usage reference

See the [package README](../README.md) for installation and client setup.

## Public market data

```sh
nord-mcp serve --public --network devnet
```

Public mode exposes only `nord_list_markets` and `nord_get_market`. It needs no wallet, Nord account, profile or session, and does not create profile storage, load credentials, open a request journal or renew sessions. Devnet is the default; select `--network mainnet` explicitly for mainnet public reads. The network is fixed at startup and reported in the MCP server instructions. Provider outages and stale RFQ samples can still affect the data; `observedAt` is the fetch time, not proof that the underlying prices are fresh.

For an agent client, use command `nord-mcp` and arguments `serve`, `--public`, `--network`, `devnet`. Do not combine public mode with profile, owner, account or storage options. To switch to authenticated tools, complete setup, change the client launch arguments to `serve --profile personal`, and reconnect the MCP server. Profile mode includes the same public market tools plus account and trading tools.

## Authorization and storage

Browser setup and OS credential storage are defaults; devnet is the default network. Mainnet requires `--network mainnet` during setup. Network and owner are immutable for a profile; create another profile to change them. Choose an existing Nord account with `--account-id` or select one when prompted. This package does not initialize or fund accounts.

Browser authorization supports external Solana wallets controlling the Nord owner. Open the temporary loopback page, choose a Wallet Standard wallet, inspect the exact owner/network/account/session/deadlines, and approve its message. If several Nord accounts are available, select one in the terminal before reviewing the session in the browser. “Signature returned” means the browser has handed the signature to the CLI; wait for the CLI to confirm Nord authorization. Email/Turnkey login and hardware-wallet transaction signing are not supported.

The CLI retains the session secret. The browser returns only the owner public key and its signature. The loopback listener rejects mismatched origins, hosts, owners and replayed approvals, serves bundled scripts, and closes after completion, cancellation or ten minutes. Treat the single-use setup URL as private until the listener closes.

```sh
nord-mcp setup --profile dev --method browser --network devnet --account-id 7
nord-mcp setup --profile headless --method keyfile --owner-keyfile /private/path/owner.json --account-id 7 --storage file
```

Keyfile setup accepts a Solana JSON keypair file and asks for confirmation after displaying the authorization. The owner key and its path are not saved in the profile. Raw private keys are never accepted as command arguments or tool inputs.

For browser approval on a headless machine, forward the port printed by setup to the same local port, for example `ssh -N -L 54321:127.0.0.1:54321 host`, then open the printed URL on the machine running the wallet. The listener remains bound to loopback. A headless host needs a working OS credential store or explicit `--storage file`.

**Credential authority:** Nord session keys have broader protocol authority than these tools, including transfers and withdrawals. A profile's selected account and omitted tools are local software boundaries, not protocol-enforced key restrictions. Anyone who obtains a session secret can bypass this package. Use a dedicated account with an amount of funds appropriate to that authority.

OS credentials use `@napi-rs/keyring`; Linux needs a supported, unlocked credential-store backend. An unavailable native backend never silently switches to files. Explicit file mode stores plaintext secrets in owner-only files and private directories. It is not encrypted by this package. Unsafe ownership, permissions and symlink paths are rejected. `profiles list` omits unreadable profiles with a warning; `status --profile <name>` reports the individual failure. Listing does not loosen storage validation.

Profiles, pending authorizations, journals and credentials live outside the repository. Defaults are `~/Library/Application Support/nord-mcp` on macOS and `${XDG_CONFIG_HOME:-~/.config}/nord-mcp` on Linux; `NORD_MCP_CONFIG_HOME` can explicitly override the root. Back up this directory securely if preserving unresolved request history matters.

## Tools and order inputs

The tools are `nord_get_connection`, `nord_list_markets`, `nord_get_market`, `nord_get_account`, `nord_list_positions`, `nord_list_open_orders`, `nord_list_order_history`, `nord_get_order`, `nord_preview_order`, `nord_place_order`, `nord_cancel_order` and `nord_get_request`.

Market discovery resolves symbols to IDs. Account and market values are decimal strings. List pages default to 20 and cap at 50; history returns backend cursors unchanged. Snapshot lists explicitly identify local keyset pagination. Unknown values, including equity when no authoritative equity field is available, are null rather than zero.

Order inputs specify market ID, buy/sell, market/limit, exactly one of `baseSize` or `quoteNotional`, and optional `reduceOnly` (default false). Limit orders require `limitPrice`; market orders require integer `slippageBps` from 0 to 9999. Submission also requires a stable `requestId`. Quote amounts mean quote-denominated position notional, not collateral, margin or leverage.

```json
{
  "requestId": "rebalance-2026-09-09-001",
  "order": {
    "marketId": "0",
    "side": "buy",
    "type": "market",
    "quoteNotional": "100",
    "slippageBps": 50,
    "reduceOnly": false
  }
}
```

CLOB market orders are IOC with a protective limit derived from the executable book side. Limit orders use Nord's native limit behavior. Native quote sizing is retained; explicit precision is rejected rather than silently truncated. Derived sizes round down; buy bounds round down and sell bounds round up. Self-trade prevention expires the maker. Partial fills, resting size and unfilled notional are distinct; quote notional excludes fees.

RFQ tools use user `placeRfqOrder`, never maker fills. They accept market-style requests with a worst acceptable price and Nord's default timeout. Pricing needs a complete finalized sample no older than 30 seconds and an index observation no older than 10 seconds. The sampled bid/ask midpoint's relationship to the sampled index is applied to the current index; there is no fitted depth estimator or fill guarantee. Quote sizing produces a conservative base quantity and is a **notional target, not a native quote execution cap**. RFQ limit orders and cancellation are unsupported. Placement acknowledgement is separate from eventual fill/expiry; inspect order history and fills.

Preview and placement share preparation code. Placement reacquires state and validates ownership, session tuple, mode, regime, freshness and precision before signing. No arbitrary signing, raw actions, maker RFQ fills, funding, withdrawals, transfers, administration, TP/SL management or scheduling are exposed.

## Requests and session lifecycle

Before transmission, SQLite durably records the profile/account, request ID, canonical arguments/fingerprint, client order ID, unsigned action bytes/hash, timestamp/nonce and reconciliation cursor. Newly assigned client order IDs fit Nord's U63 domain; stored IDs are never regenerated during retry or recovery. It does not store private keys or signed payloads. Receipts are persisted before replying. Submission state and order lifecycle are separate.

The same request ID with the same arguments returns or reconciles that operation. If a crash left it `prepared` with no persisted action identity, repeating the original write tool resumes preparation with fresh validation and the same client order ID; inspecting the request alone never submits it. A `prepared` result is incomplete, not successful execution. Different arguments conflict. An unknown operation is never automatically replaced, and unresolved identical intent cannot bypass recovery by using a new ID. History lag, an empty open-order list, client order IDs and Nord's temporary deduplication cache are not permanent exactly-once guarantees. `nord_get_request` advances bounded reconciliation; if evidence remains missing, the outcome remains unknown.

```sh
nord-mcp status --profile personal
nord-mcp requests list --profile personal
nord-mcp requests inspect rebalance-2026-09-09-001 --profile personal
nord-mcp renew --profile personal
nord-mcp revoke --profile personal
nord-mcp profiles list
nord-mcp profiles remove personal
```

Each session has a 24-hour lease and a seven-day authorization deadline. Setup verifies the Solana network, account ownership and exact remote session parameters before activating a profile. Setup and runtime require Nord to report a verifiable refresh deadline; a missing deadline is rejected rather than inferred from local configuration. The process checks renewal at startup and hourly, renewing only when fewer than 12 hours remain. It never renews an already expired session or beyond the authoritative deadline. Expiry requires another setup. Renewal ambiguity is reconciled before another attempt.

Interrupted setup keeps its pending key and inspects the exact public key on Nord when resumed. An ambiguous submitted authorization is not submitted again. Profile replacement verifies and activates the successor before attempting to revoke its predecessor; an unverified predecessor remains explicitly recorded. Recovery rechecks the pending private key even if authorization already exists remotely; an unavailable or mismatched key leaves the current profile intact. Another replacement is blocked while a predecessor remains unverified. Run `nord-mcp revoke --profile <name>` to verify revocation of both recorded sessions before setting up again; neither revocation nor local removal cancels open orders.

Stop the profile's serving process before using a CLI mutation. Revocation reports success only after checking Nord. Local removal deletes local credentials and the active profile but retains request history and explicitly reports any unverified remote access. Neither command cancels outstanding orders. Closing the MCP call or process also does not cancel an already submitted order.

# Devnet acceptance

Use this procedure to validate a built package through real MCP clients. Fixtures and a successful placement acknowledgement alone do not establish live trading support. Use the [testing instructions](testing.md) to prepare the build and fixtures.

## Prepare a dedicated account

1. Build the package and run the [automated checks](testing.md#automated-checks).
2. Use a dedicated Solana Devnet wallet and keep its owner key outside the repository. Confirm the configured network before funding or signing.
3. Fund the wallet with Devnet SOL for fees and supported mock collateral. Deposit collateral using an existing Nord interface or SDK; this package does not initialize or fund accounts. A token appearing in market metadata does not prove that the bridge accepts deposits for it.
4. Confirm the deposit finalized and Nord reports the funded account owned by the expected wallet. If ingestion is delayed, reconcile the existing deposit before submitting another.
5. Run `nord-mcp setup --profile devnet-test --method keyfile --owner-keyfile /private/path/owner.json --network devnet`, or use `--method browser` with a compatible wallet. Confirm the displayed account, storage mode, credential authority and session deadlines.
6. Connect the MCP client to `nord-mcp serve --profile devnet-test`. Use one serving process per profile.

Session keys have authority beyond the tools exposed by this package. Use only the test account and a small amount of mock collateral appropriate to that authority. Do not commit wallet files, profile data, setup URLs, request journals or account-specific transcripts.

## CLOB checks

| Scenario                    | Required observation                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and reads          | Correct Devnet owner/account, authoritative collateral balance, market capabilities, current positions and open orders                 |
| Limit preview and placement | Preview is indicative; submission uses fresh state; receipt and account state identify the resting order and remaining size            |
| Retry after process restart | Identical request ID and arguments return the original accepted action/order without creating a second order                           |
| Cancellation                | Cancellation receipt and authoritative order state agree; account no longer lists the order as open; any raced fills are accounted for |
| Quote-sized market order    | IOC respects explicit protection and quote sizing; receipt reports actual fills and remainder                                          |
| Reduce-only close           | Position decreases or closes without flipping direction; verify the resulting account position                                         |
| Partial fill                | Controlled liquidity produces a partial execution; filled, unfilled and resting quantities are distinguished correctly                 |

Use the discovery tools to choose a current CLOB market and valid precision. Assign a stable request ID to each intended write. On an unknown outcome, inspect/reconcile that request instead of creating a replacement ID. An empty open-order list does not prove rejection.

For IOC execution, use authoritative receipts and position changes; do not assume the historical resting-order page includes every IOC action. A remainder caused by quantity precision is distinct from a liquidity-limited partial fill.

## RFQ checks

Use a market with a complete finalized sample no older than 30 seconds, an index observation no older than 10 seconds and controlled responding liquidity. Do not relax freshness checks to force a test through.

Verify placement acknowledgement separately from eventual order state and fills. Exercise both a filled request and a request that expires without filling. Check the resulting position and verify that unsupported RFQ limit and cancellation requests return capability errors. Quote sizing is a notional target converted to base size, not a native quote-amount execution cap.

If fresh samples or controlled liquidity are unavailable, record the check as unverified rather than reporting placement as successful execution.

## Sessions and client behavior

- Exercise keyfile and browser authorization separately. For browser setup, test Phantom and Solflare, signature rejection, interrupted setup and verified replacement of an existing session.
- Test renewal inside the renewal window, expiry recovery and the authorization deadline. Running `renew` with more than twelve hours remaining only tests the no-op path.
- Inspect requests after interrupted calls. MCP cancellation or process termination does not cancel a submitted order.
- Stop the serving process before CLI mutations. Revoke the session, confirm it is absent remotely, then verify a write fails before submission. Revocation does not cancel outstanding orders.
- Run native discovery/read/trading calls through each supported agent client. A generic SDK STDIO client does not establish native Codex or Claude Code trading behavior.

## Completion criteria

Close test positions, cancel remaining orders and verify remote session revocation. Account for any unknown requests before reporting completion. Keep receipts, client/runtime versions, scenario outcomes and account-specific evidence in private test storage.

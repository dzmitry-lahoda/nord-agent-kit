# Nord adapter architecture

The package uses the published `@n1xyz/nord-ts@0.7.4` SDK. Protocol integration is isolated in `src/nord` and depends only on public SDK schemas, enums and encoding/scaling utilities.

| Module               | Responsibility                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `nord/session.ts`    | Session action construction, nonce initialization, CLOB/user RFQ execution, cancellation, renewal, revocation and separate owner authorization |
| `nord/submission.ts` | Unsigned action identity, signature framing, bounded transport, raw receipts and structured submission outcomes                                |
| `nord/reads.ts`      | Network endpoints, lossless response parsing and account/session verification                                                                  |

`NordSession` receives a session ID, timestamp provider, market precision, signer, transport and persistence callbacks. It does not receive owner keys, profiles or credential stores. Owner authorization uses the separate `authorizeSession` function during CLI setup.

The journal owns durability. Its callbacks persist unsigned action identity before signing/transmission and raw receipts before returning. Signed payloads and secrets never enter those callbacks. Submission errors distinguish local failure, explicit rejection and unknown outcomes; duplicate responses do not prove rejection of an earlier attempt.

MCP schemas, approval handling, profiles, credentials, process locking, SQLite persistence and request recovery remain outside the adapter. `order-preparation.ts` owns slippage and freshness policy; `receipts.ts` presents execution results to tools.

The build bundles the SDK's published Node entry point, and type-checking uses its public declarations. ESLint rejects SDK-internal imports. The adapter does not mutate SDK instances or patch runtime prototypes. Protocol parity and fault-injection tests are described in [testing](testing.md).

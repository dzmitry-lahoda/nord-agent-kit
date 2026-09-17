# Testing

Run automated checks before submitting changes. Use fixtures for deterministic behavior and dedicated Devnet accounts for integration testing.

## Automated checks

From the repository root:

```sh
cd packages/mcp-server
bun ci
bun run ci
bun run test
bun run build
node scripts/pack-test.mjs
# Optional public Devnet reads through a clean installed artifact:
node scripts/pack-test.mjs --live
```

CI runs static checks, tests, builds and packed-install checks on macOS and Linux with Node 22.13.0 and 24.11.1. Live provider calls are opt-in. The packed-install check verifies the shipped file list and checks that the installed CLI and MCP handshake report the package version.

`npm pack` builds the executable and browser assets through `prepack`, including from a checkout without `dist`. JavaScript dependencies are bundled; the native keyring is optional and loaded lazily. Consumers need Node, not Bun or another repository checkout. `bun run fmt` formats maintained code and documentation. The fixture server is development-only and is not shipped. Server STDOUT carries MCP messages; diagnostics go to STDERR.

The tests exercise modern and legacy MCP clients, public-mode isolation, schemas and pagination, precise quantities, credential storage, browser callbacks, session lifecycle, order preparation and durable request recovery. Protocol adapter tests compare signed bytes with the pinned SDK. Fault-injection tests cover lost responses, receipt persistence failures and retries across restart.

Add regression coverage when changing these contracts. Requests with unknown outcomes must never be blindly resubmitted; a request with no persisted action identity may resume only after fresh validation. Keep order acceptance separate from fills and final order state.

## Integration testing

Follow the [Devnet test procedure](devnet-acceptance.md) for wallet authorization, CLOB and RFQ execution, session renewal and revocation. Use only dedicated test accounts and keep wallet files, profile storage and account-specific evidence outside the repository.

Fixture wallets do not reproduce extension behavior or OS credential permission dialogs. Exercise those integrations directly. Use native tool calls in each agent client when changing client integration; a generic SDK STDIO client tests the protocol, not the client's approval or tool-use behavior.

RFQ placement acknowledgement is not proof of execution. Inspect authoritative receipts, order state and fills. Likewise, a quote-size remainder caused by precision is not proof of a liquidity-limited partial fill.

## Agent evaluations

The [read-only evaluation suite](../evaluations/README.md) uses synthetic data without credentials or external calls. Run each question independently, without exposing its expected answer to the agent. Keep run-specific reports outside the repository.

See [publishing](releasing.md) for the manual release procedure.

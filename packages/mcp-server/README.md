# Nord local MCP

Local MCP tools for Nord market data, account reads and CLOB/RFQ trading. The agent client launches the server over STDIO; no hosted MCP service is required.

**Alpha software:** This project is in active development. Use it at your own risk, including the risk of financial loss.

## Install and connect

Requires macOS or Linux and Node.js 22.13+.

```sh
npm install -g @n1xyz/nord-mcp-server@0.1.0-alpha.0
```

This installs the `nord-mcp` executable and bundled browser authorization page. Bun and a source checkout are only needed for development. To update within the alpha release channel, run `npm install -g @n1xyz/nord-mcp-server@alpha`.

For authenticated tools, use an existing funded Nord account and authorize a dedicated session:

```sh
nord-mcp setup --profile personal
```

Setup defaults to Devnet, browser-wallet approval and OS credential storage. Mainnet requires explicit `--network mainnet`. The package does not create or fund accounts. See [authorization and storage](docs/usage.md#authorization-and-storage) for keyfile setup, headless hosts and profile configuration.

Add the server to your client:

```sh
codex mcp add nord -- nord-mcp serve --profile personal
claude mcp add --transport stdio nord -- nord-mcp serve --profile personal
```

Alternatively, configure command `nord-mcp` with arguments `serve`, `--profile`, `personal`. Use an absolute executable path if your GUI client's PATH differs from your terminal. Only one process may use a profile at a time; create separate profiles for simultaneous clients.

## Public market data

To use market discovery and pricing without a wallet or profile, configure the client to launch:

```sh
nord-mcp serve --public --network devnet
```

Public mode exposes `nord_list_markets` and `nord_get_market`. To switch to authenticated tools, complete setup, change the launch arguments to `serve --profile personal`, and reconnect. See [public-mode options](docs/usage.md#public-market-data).

## Trading and account tools

Authenticated mode adds account balances, positions, order history, previews, placement, CLOB cancellation and request recovery. Orders use a market ID, buy/sell direction and exactly one base quantity or quote notional. Market orders require explicit slippage protection; limit orders require a price. Quote amounts are position notional, not collateral or leverage.

See the [tool and order reference](docs/usage.md#tools-and-order-inputs) for tool names, inputs, examples, sizing and market capabilities.

## Safety and recovery

**Session authority:** Nord session keys permit more than the exposed tools, including transfers and withdrawals. Profile binding is not a protocol-level restriction. Use a dedicated account and protect the session credential. OS credential storage is the default; explicit file mode is plaintext.

- Client approval settings govern trading. A preview does not authorize a later trade.
- Reuse the same request ID and arguments after an interrupted write. Inspect unknown outcomes; do not submit a replacement with a new ID.
- RFQ placement acknowledgement is not a fill. RFQ quote sizing is a notional target, not a native execution cap. RFQ limit orders and cancellation are unsupported.
- Stopping the server, cancelling an MCP call or revoking a session does not cancel outstanding orders.

Sessions use a 24-hour lease with renewal bounded by a seven-day authorization deadline. Stop the serving process before CLI mutations. See [request recovery and session management](docs/usage.md#requests-and-session-lifecycle) for inspection, renewal, revocation and removal commands.

## Contributing

From the repository root:

```sh
cd packages/mcp-server
bun ci
npm pack
npm install -g ./n1xyz-nord-mcp-server-0.1.0-alpha.0.tgz
```

See [testing instructions](docs/testing.md), the [Devnet test procedure](docs/devnet-acceptance.md), [agent evaluations](evaluations/README.md) and the [SDK adapter architecture](docs/nord-adapter.md).

## License

Licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution. Third-party dependencies retain their respective licenses. See [supplemental third-party notices](THIRD_PARTY_NOTICES.txt) and the license comments preserved in `dist/cli.js.LEGAL.txt`.

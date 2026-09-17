# Nord Agent Kit

Tools for connecting AI agents to Nord. Use the kit to access market data, inspect accounts and execute trades through session-authorized integrations.

Each package provides its own setup instructions, supported interfaces and usage documentation.

**Alpha software:** This project is in active development. Use it at your own risk, including the risk of financial loss.

## Packages

| Package                  | Description                                                                                                           | Documentation                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `@n1xyz/nord-mcp-server` | Local MCP server for public market data, account reads and CLOB/RFQ trading in clients such as Codex and Claude Code. | [MCP server](packages/mcp-server/README.md) |

## Getting started

Choose a package above and follow its installation guide. To connect an MCP-compatible agent, start with the [MCP server setup](packages/mcp-server/README.md#install-and-connect). Public market data is available without a wallet or profile; account and trading tools require session authorization.

## Contributing

Packages live under `packages/`. Follow the relevant package's development instructions and run its checks before submitting changes. For the MCP server, see [contributor guidance](packages/mcp-server/README.md#contributing) and [testing instructions](packages/mcp-server/docs/testing.md).

## License

Licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution. Third-party dependencies retain their respective licenses.

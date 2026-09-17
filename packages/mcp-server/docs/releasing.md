# Publishing

Releases are published manually from `packages/mcp-server`. Use an npm account authorized to publish under `@n1xyz`, with two-factor authentication enabled.

## Prepare a release

1. Update `version` in `package.json`. The CLI and MCP server use that same version.
2. Update versioned installation examples in the README.
3. Run `bun ci`, `bun run ci`, `bun run test` and `node scripts/pack-test.mjs`.
4. Review the archive contents and dependency license obligations, including dependencies already bundled inside the Nord SDK. Preserved license comments alone are not a complete license review.
5. Review and merge the release PR, then create the release archive from the reviewed commit.

## Publish the reviewed archive

```sh
npm pack
# Inspect the exact archive before publishing:
tar -tzf n1xyz-nord-mcp-server-0.1.0-alpha.0.tgz
npm publish ./n1xyz-nord-mcp-server-0.1.0-alpha.0.tgz --dry-run --access public --tag alpha
# After release approval:
npm publish ./n1xyz-nord-mcp-server-0.1.0-alpha.0.tgz --access public --tag alpha
```

Substitute the release version in archive names. Publish the archive that was reviewed and tested. The package defaults to public visibility and the `alpha` distribution tag; do not move an alpha release to `latest`. Each published version must be unique.

## Verify the published release

Install the exact version from npm in a clean environment, run `nord-mcp --version`, and connect an MCP client in public mode. Verify tool discovery and public market reads before updating public documentation and navigation links. Consumers need macOS or Linux and Node.js 22.13+; they do not need Bun or repository access.

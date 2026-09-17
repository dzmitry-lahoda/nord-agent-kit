import { tempRoot } from "./temp";
import { mkdtempSync, rmSync } from "node:fs";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Profiles } from "../src/storage";
import { Runtime } from "../src/runtime";
import { createServer } from "../src/server";
import { FixtureReads, profile } from "./fixtures";
process.umask(0o077);
const root = tempRoot("nord-mcp-fixture-");
const profiles = new Profiles(root);
profiles.save(profile);
const runtime = new Runtime(profiles, profile, new FixtureReads());
runtime.journal.begin(
  "never-sent",
  "devnet:fixture:7",
  "place",
  { marketId: "2" },
  "99",
);
runtime.journal.begin(
  "lost-response",
  "devnet:fixture:7",
  "place",
  { marketId: "0" },
  "99",
);
runtime.journal.beforeSend("lost-response", {
  unsignedPayload: "AQ==",
  hash: "does-not-match",
  timestamp: "1700000000",
  nonce: 1,
});
const handle = serveStdio(() => createServer(runtime), { legacy: "serve" });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await handle.close();
  await runtime.close();
  rmSync(root, { recursive: true, force: true });
}
process.stdin.on("end", () => void close());
process.on("SIGTERM", () => void close());

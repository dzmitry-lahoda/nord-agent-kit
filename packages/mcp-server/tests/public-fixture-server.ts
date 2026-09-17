import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createPublicServer } from "../src/server";
import { NordReads } from "../src/nord/reads";
import { FixtureReads } from "./fixtures";

class PublicReads extends FixtureReads {
  override async get(path: string): Promise<unknown> {
    if (path.endsWith("/orderbook"))
      return {
        asks: Array.from({ length: 51 }, () => ["50001", "1"]),
        bids: Array.from({ length: 52 }, () => ["50000", "2"]),
      };
    return super.get(path);
  }
}
const reads = process.argv.includes("--unavailable")
  ? new NordReads(
      "devnet",
      async () => new Response("unavailable", { status: 503 }),
    )
  : new PublicReads();
const handle = serveStdio(() => createPublicServer(reads), { legacy: "serve" });
process.stdin.once("end", () => void handle.close());
process.once("SIGTERM", () => void handle.close());

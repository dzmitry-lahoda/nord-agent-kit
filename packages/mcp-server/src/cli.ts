import { version } from "../package.json";
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Profiles, credentials } from "./storage";
import { Runtime } from "./runtime";
import { Journal } from "./journal";
import { setup } from "./setup";
import { createServer, createPublicServer } from "./server";
import type { McpServer } from "@modelcontextprotocol/server";
import { NordReads } from "./nord/reads";
import { fail, publicError } from "./errors";
import { networkName, profileName, id } from "./model";
import { z } from "zod";

const HELP = `nord-mcp setup --profile NAME [--method browser|keyfile] [--network devnet|mainnet]
  [--owner-keyfile PATH] [--account-id ID] [--storage keyring|file]
nord-mcp serve --public [--network devnet|mainnet]
nord-mcp serve|status|renew|revoke --profile NAME
nord-mcp profiles list
nord-mcp profiles remove NAME
nord-mcp requests list --profile NAME
nord-mcp requests inspect REQUEST_ID --profile NAME

Browser setup, devnet and OS credential storage are defaults. Mainnet must be selected explicitly.
Public mode exposes only market discovery and market data; it does not load a profile or credentials.
Never pass a raw private key to this CLI or an MCP tool. Node.js 22.13+; macOS/Linux.
`;
async function serve(create: () => McpServer) {
  const handle = serveStdio(create, {
    legacy: "serve",
    onerror: () => process.stderr.write("MCP transport error.\n"),
  });
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.stdin.once("end", stop);
  });
  await handle.close();
}

async function main() {
  process.umask(0o077);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major! < 22 || (major === 22 && minor! < 13))
    fail("UNSUPPORTED_RUNTIME", "Node.js 22.13 or newer is required.");
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      profile: { type: "string" },
      public: { type: "boolean" },
      method: { type: "string" },
      network: { type: "string" },
      "owner-keyfile": { type: "string" },
      "account-id": { type: "string" },
      storage: { type: "string" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
  });
  if (values.help || (!positionals.length && !values.version)) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return;
  }
  const [command, subcommand, argument] = positionals;
  const arity =
    command === "profiles"
      ? subcommand === "list"
        ? 2
        : subcommand === "remove"
          ? 3
          : 0
      : command === "requests"
        ? subcommand === "list"
          ? 2
          : subcommand === "inspect"
            ? 3
            : 0
        : ["setup", "serve", "status", "renew", "revoke"].includes(command!)
          ? 1
          : 0;
  if (positionals.length !== arity)
    fail(
      "INVALID_ARGUMENTS",
      "Unexpected command arguments. Run nord-mcp --help.",
    );
  if (values.public) {
    if (
      command !== "serve" ||
      [
        values.profile,
        values.method,
        values.storage,
        values["owner-keyfile"],
        values["account-id"],
      ].some((v) => v !== undefined)
    )
      fail(
        "INVALID_ARGUMENTS",
        "Use serve --public [--network devnet|mainnet] without profile, owner, method or storage options.",
      );
    const network = networkName.parse(values.network ?? "devnet");
    // Do not construct Profiles or Runtime: public reads need no local state or signing authority.
    await serve(() => createPublicServer(new NordReads(network)));
    return;
  }
  if (
    command !== "setup" &&
    [
      values.method,
      values.network,
      values.storage,
      values["owner-keyfile"],
      values["account-id"],
    ].some((v) => v !== undefined)
  )
    fail(
      "INVALID_ARGUMENTS",
      "Network is selected during setup or public serving. Owner and storage options are setup-only; runtime profiles cannot be overridden.",
    );
  const profiles = new Profiles();
  const print = (result: unknown) =>
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (command === "setup") {
    print(
      await setup(profiles, {
        profile: profileName.parse(values.profile),
        method: z
          .enum(["browser", "keyfile"])
          .parse(values.method ?? "browser"),
        network: networkName.parse(values.network ?? "devnet"),
        storage: z.enum(["keyring", "file"]).parse(values.storage ?? "keyring"),
        ownerKeyfile: values["owner-keyfile"],
        accountId:
          values["account-id"] === undefined
            ? undefined
            : id.parse(values["account-id"]),
      }),
    );
    return;
  }
  if (command === "profiles" && subcommand === "list") {
    print(
      profiles
        .list()
        .map(({ name, network, owner, accountId, state, expiry }) => ({
          name,
          network,
          owner,
          accountId,
          state,
          expiry: String(expiry),
        })),
    );
    return;
  }
  const name = profileName.parse(
    command === "profiles" && subcommand === "remove"
      ? argument
      : values.profile,
  );
  const unlock = profiles.lock(name);
  let runtime: Runtime | undefined;
  try {
    if (command === "requests" && !profiles.load(name)) {
      const journal = new Journal(profiles, name);
      try {
        print(
          subcommand === "list"
            ? journal.list(50)
            : (journal.get(argument!) ??
                fail(
                  "REQUEST_NOT_FOUND",
                  "No retained request with this ID exists.",
                )),
        );
      } finally {
        journal.close();
      }
      return;
    }
    runtime = new Runtime(
      profiles,
      command === "profiles" && subcommand === "remove"
        ? (profiles.load(name) ??
          profiles.load(name, true) ??
          profiles.require(name))
        : profiles.require(name),
    );
    if (command === "serve") {
      // Expiry or renewal failure must not disable reads, cancellation inspection or recovery.
      await runtime
        .renew()
        .catch(() =>
          process.stderr.write(
            "Session readiness needs attention; use nord_get_connection or nord-mcp status.\n",
          ),
        );
      runtime.startRenewal();
      const active = runtime;
      await serve(() => createServer(active));
      return;
    }
    if (command === "status") {
      print(await runtime.connection());
      return;
    }
    if (command === "renew") {
      print(await runtime.renew());
      return;
    }
    if (command === "revoke") {
      print(await runtime.revoke());
      return;
    }
    if (command === "requests" && subcommand === "list") {
      print(runtime.journal.list(50));
      return;
    }
    if (command === "requests" && subcommand === "inspect" && argument) {
      print(await runtime.reconcile(argument));
      return;
    }
    if (command === "profiles" && subcommand === "remove") {
      const pending = profiles.load(name, true);
      const targets = [
        runtime.profile,
        ...(pending ? [pending] : []),
        ...(runtime.profile.predecessor
          ? [{ ...runtime.profile, ...runtime.profile.predecessor }]
          : []),
      ];
      const unique = [
        ...new Map(targets.map((p) => [p.credentialId, p])).values(),
      ];
      const access: {
        sessionPublicKey: string;
        sessionIds: string[];
        remoteAccess: string;
      }[] = [];
      for (const target of unique) {
        let sessionIds: string[] = [],
          remoteAccess = "unverified";
        try {
          const user = await runtime.reads.verifyOwner(target);
          sessionIds = Object.entries(user.sessions)
            .filter(([, s]) => s.pubkey === target.sessionPublicKey)
            .map(([id]) => id);
          remoteAccess = sessionIds.length ? "remains" : "absent";
        } catch {
          /* Local removal stays available during provider outages. */
        }
        access.push({
          sessionPublicKey: target.sessionPublicKey,
          sessionIds,
          remoteAccess,
        });
        await (
          await credentials(profiles, target.storage)
        ).delete(target.credentialId);
      }
      profiles.remove(name);
      print({
        removed: name,
        network: runtime.profile.network,
        owner: runtime.profile.owner,
        access,
        outstandingOrders: "unchanged",
        journal: "retained",
        warning: access.some((x) => x.remoteAccess !== "absent")
          ? "Local removal does not revoke remote access. Revoke the listed sessions through the owner wallet."
          : null,
      });
      return;
    }
    fail("INVALID_ARGUMENTS", "Unknown command. Run nord-mcp --help.");
  } finally {
    await runtime?.close();
    unlock();
  }
}
main().catch((error) => {
  const result =
    error instanceof z.ZodError
      ? {
          code: "INVALID_ARGUMENTS",
          message: "Invalid or missing CLI arguments. Run nord-mcp --help.",
        }
      : publicError(error);
  process.stderr.write(`${result.code}: ${result.message}\n`);
  process.exitCode = 1;
});

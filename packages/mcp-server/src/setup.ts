import { authorizeSession } from "./nord/session";
import { NordSubmissionError, actionTransport } from "./nord/submission";
import { Keypair } from "@solana/web3.js";
import { signAsync } from "@noble/ed25519";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { NordReads } from "./nord/reads";
import { Profiles, credentials } from "./storage";
import { browserApproval, type BrowserSigner } from "./browser-auth";
import { profileName, type Profile } from "./model";
import { fail } from "./errors";
import { Runtime } from "./runtime";

export const AUTHORITY =
  "Nord session keys have broader authority than these trading tools, including transfers and withdrawals. Binding one account locally and omitting tools does not restrict the key at the protocol level.";
export type SetupOptions = {
  profile: string;
  method: "browser" | "keyfile";
  network: "devnet" | "mainnet";
  storage: "keyring" | "file";
  ownerKeyfile?: string;
  accountId?: string;
};
async function question(prompt: string): Promise<string> {
  if (!process.stdin.isTTY)
    fail(
      "INTERACTION_REQUIRED",
      "Run setup in an interactive terminal or supply --account-id when selecting an account.",
    );
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}
async function selectAccount(
  reads: NordReads,
  owner: string,
  supplied?: string,
): Promise<string> {
  const accounts = (await reads.user(owner)).accountIds;
  if (!accounts.length)
    fail(
      "ACCOUNT_NOT_FOUND",
      "No Nord account exists for this wallet. Create and fund an account through Nord, then run setup again.",
    );
  if (supplied !== undefined) {
    if (!accounts.includes(supplied))
      fail(
        "OWNER_MISMATCH",
        "The selected account is not owned by this wallet.",
      );
    return supplied;
  }
  if (accounts.length === 1) return accounts[0]!;
  const selected = await question(
    `Choose one Nord account (${accounts.join(", ")}): `,
  );
  if (!accounts.includes(selected))
    fail("INVALID_ACCOUNT", "Choose an account ID from the owner's accounts.");
  return selected;
}
export async function setup(profiles: Profiles, options: SetupOptions) {
  profileName.parse(options.profile);
  const unlock = profiles.lock(options.profile);
  try {
    const existing = profiles.load(options.profile);
    if (existing && existing.network !== options.network)
      fail("PROFILE_CONFLICT", "Network changes require another profile name.");
    if (existing?.predecessor)
      fail(
        "PREDECESSOR_ACCESS_UNVERIFIED",
        `A previous replacement still has unverified remote access. Run nord-mcp revoke --profile ${options.profile} to verify revocation of both recorded sessions before setting up another replacement.`,
      );
    const reads = new NordReads(options.network);
    await reads.validateNetwork();
    const store = await credentials(profiles, options.storage);
    // Check both writing and retrieval before asking a wallet for authority.
    const probe = randomUUID();
    const bytes = Keypair.generate().secretKey;
    await store.put(probe, bytes);
    await store.get(probe);
    await store.delete(probe);
    if (options.storage === "file")
      process.stderr.write(
        "File storage is plaintext, protected by OS ownership and permissions; the package does not encrypt it.\n",
      );
    process.stderr.write(`${AUTHORITY}\n`);

    async function authorize(owner: string, sign: BrowserSigner) {
      if (existing && existing.owner !== owner)
        fail("PROFILE_CONFLICT", "Owner changes require another profile name.");
      let pending = profiles.load(options.profile, true);
      if (
        pending &&
        (pending.owner !== owner ||
          pending.network !== options.network ||
          pending.storage !== options.storage ||
          (options.accountId && options.accountId !== pending.accountId))
      )
        fail(
          "PENDING_SETUP_CONFLICT",
          "A different setup is pending. Resume it with the same owner, network, account, and storage before replacing it.",
        );
      if (!pending) {
        const session = Keypair.generate();
        const credentialId = randomUUID();
        await store.put(credentialId, session.secretKey);
        try {
          const accountId = await selectAccount(
            reads,
            owner,
            options.accountId,
          );
          const now = await reads.timestamp();
          pending = {
            version: 1,
            name: options.profile,
            network: options.network,
            owner,
            accountId,
            sessionPublicKey: session.publicKey.toBase58(),
            expiry: now + 86400,
            deadline: now + 604800,
            credentialId,
            storage: options.storage,
            state: "pending",
            ...(existing?.sessionId
              ? {
                  predecessor: {
                    credentialId: existing.credentialId,
                    storage: existing.storage,
                    sessionId: existing.sessionId,
                    sessionPublicKey: existing.sessionPublicKey,
                    expiry: existing.expiry,
                    deadline: existing.deadline,
                  },
                }
              : {}),
          };
          profiles.save(pending, true);
        } catch (error) {
          await store.delete(credentialId);
          throw error;
        }
      }
      // Recovery must prove the successor can sign before replacing a working
      // profile, even when its authorization already exists remotely.
      let publicKey: string;
      try {
        const key = await store.get(pending.credentialId);
        try {
          publicKey = Keypair.fromSecretKey(key).publicKey.toBase58();
        } finally {
          key.fill(0);
        }
      } catch {
        fail(
          "CREDENTIAL_UNAVAILABLE",
          "Pending credential is missing, unreadable, or invalid. Unlock the credential store or restore the pending key before retrying. Existing profile and pending authorization were retained.",
        );
      }
      if (publicKey !== pending.sessionPublicKey)
        fail(
          "CREDENTIAL_MISMATCH",
          "Pending credential does not match its public key. Restore the correct key before retrying; the existing profile and pending authorization were retained.",
        );
      await reads.verifyOwner(pending);
      const discover = async () =>
        Object.entries((await reads.user(owner)).sessions).filter(
          ([, s]) => s.pubkey === pending!.sessionPublicKey,
        );
      let matches = await discover();
      if (matches.length > 1)
        fail(
          "AMBIGUOUS_SESSION",
          "Multiple Nord sessions match the pending public key. Inspect Nord and revoke duplicates before proceeding.",
        );
      if (!matches.length) {
        if (pending.authorizationState === "submitting")
          fail(
            "UNKNOWN_AUTHORIZATION_OUTCOME",
            "A prior authorization is unresolved. Pending key retained; retry setup to inspect Nord again. No second authorization will be submitted.",
          );
        if (pending.expiry <= (await reads.timestamp()))
          fail(
            "PENDING_SETUP_EXPIRED",
            "Pending authorization expired. Inspect and revoke any remote access before removing this pending profile.",
          );
        const params = {
          owner,
          network: pending.network,
          accountId: pending.accountId,
          sessionPublicKey: pending.sessionPublicKey,
          expiry: pending.expiry,
          deadline: pending.deadline,
          storage: pending.storage,
        };
        process.stderr.write(`${JSON.stringify(params, null, 2)}\n`);
        let signingFailure: { error: unknown } | undefined;
        let submissionEnabled = false;
        try {
          await authorizeSession({
            transport: actionTransport(reads.config.nord),
            timestamp: BigInt(await reads.timestamp()),
            owner,
            sessionPublicKey: pending.sessionPublicKey,
            expiry: BigInt(pending.expiry),
            deadline: BigInt(pending.deadline),
            signMessage: async (message) => {
              let signature: Uint8Array;
              try {
                signature = await sign(message, params);
              } catch (error) {
                // The transport sanitizes signing errors; preserve the setup
                // cancellation/error locally without changing transport safety.
                signingFailure = { error };
                throw error;
              }
              pending!.authorizationState = "submitting";
              profiles.save(pending!, true);
              submissionEnabled = true;
              return signature;
            },
          });
        } catch (error) {
          if (!submissionEnabled)
            throw signingFailure ? signingFailure.error : error;
          // Only a proved local failure or explicit protocol rejection permits another authorization attempt.
          let cause: unknown = error;
          for (let depth = 0; depth < 10 && cause instanceof Error; depth++) {
            if (
              cause instanceof NordSubmissionError &&
              cause.outcome !== "unknown"
            ) {
              pending.authorizationState = "rejected";
              profiles.save(pending, true);
              break;
            }
            cause = cause.cause;
          }
        }
        matches = await discover();
        if (matches.length !== 1)
          fail(
            "UNKNOWN_AUTHORIZATION_OUTCOME",
            "Authorization has not been verified. Pending key retained. Run the same setup command to reconcile; do not authorize another session manually.",
          );
      }
      const [sessionId] = matches[0]!;
      const active: Profile = { ...pending, sessionId, state: "active" };
      const verified = await reads.session(active);
      if (
        verified.expiry > pending.expiry ||
        verified.deadline !== pending.deadline ||
        verified.expiry <= (await reads.timestamp())
      )
        fail(
          "SESSION_MISMATCH",
          "Remote authorization parameters differ from the pending setup.",
        );
      active.expiry = verified.expiry;
      profiles.save(active);
      profiles.clearPending(active.name);
      if (active.predecessor) {
        const predecessor = {
          ...active,
          ...active.predecessor,
          predecessor: undefined,
        };
        const runtime = new Runtime(profiles, predecessor, undefined, false);
        try {
          await runtime.revoke();
          await (
            await credentials(profiles, predecessor.storage)
          ).delete(predecessor.credentialId);
          delete active.predecessor;
          profiles.save(active);
        } catch {
          process.stderr.write(
            "Replacement verified, but predecessor revocation is unverified. Its remote access may remain; the predecessor reference is retained in the profile.\n",
          );
        } finally {
          await runtime.close();
        }
      }
      return {
        profile: active.name,
        network: active.network,
        accountId: active.accountId,
        sessionId: active.sessionId,
        expiry: String(active.expiry),
        deadline: String(active.deadline),
        predecessorAccess: active.predecessor
          ? "unverified"
          : "revoked-or-none",
      };
    }
    if (options.method === "keyfile") {
      if (!options.ownerKeyfile)
        fail(
          "INVALID_ARGUMENTS",
          "Keyfile setup requires --owner-keyfile pointing to a Solana JSON keypair file.",
        );
      const json = z
        .array(z.number().int().min(0).max(255))
        .length(64)
        .parse(JSON.parse(await readFile(options.ownerKeyfile, "utf8")));
      const key = new Uint8Array(json);
      json.fill(0);
      try {
        const owner = Keypair.fromSecretKey(key).publicKey.toBase58();
        return await authorize(owner, async (message) => {
          if (
            (
              await question("Authorize this session? Type yes: ")
            ).toLowerCase() !== "yes"
          )
            fail(
              "AUTHORIZATION_CANCELLED",
              "Authorization cancelled; pending key retained.",
            );
          return signAsync(message, key.slice(0, 32));
        });
      } finally {
        key.fill(0);
      }
    }
    if (options.ownerKeyfile)
      fail(
        "INVALID_ARGUMENTS",
        "--owner-keyfile is only valid with --method keyfile.",
      );
    const browser = await browserApproval(authorize);
    process.stderr.write(
      `Open locally: ${browser.url}\nFor a headless host, forward this exact loopback port before opening the URL.\n`,
    );
    try {
      return await browser.completed;
    } finally {
      browser.close();
    }
  } finally {
    unlock();
  }
}

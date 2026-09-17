import test from "node:test";
import readline from "node:readline/promises";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { setup, type SetupOptions } from "../src/setup";
import { NordReads } from "../src/nord/reads";
import { Runtime } from "../src/runtime";
import { Profiles, credentials } from "../src/storage";
import type { Profile } from "../src/model";
import { profile } from "./fixtures";
import { tempRoot } from "./temp";

async function fixture(t: test.TestContext) {
  const root = tempRoot("nord-setup-test-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profiles = new Profiles(root);
  const store = await credentials(profiles, "file");
  const owner = Keypair.generate(),
    session = Keypair.generate();
  const ownerKeyfile = join(root, "owner.json");
  writeFileSync(ownerKeyfile, JSON.stringify(Array.from(owner.secretKey)), {
    mode: 0o600,
  });
  const existing: Profile = { ...profile, owner: owner.publicKey.toBase58() };
  const {
    credentialId,
    storage,
    sessionId,
    sessionPublicKey,
    expiry,
    deadline,
  } = existing;
  const pending: Profile = {
    ...existing,
    sessionId: undefined,
    state: "pending",
    credentialId: randomUUID(),
    sessionPublicKey: session.publicKey.toBase58(),
    predecessor: {
      credentialId,
      storage,
      sessionId: sessionId!,
      sessionPublicKey,
      expiry,
      deadline,
    },
    authorizationState: "submitting",
  };
  profiles.save(existing);
  profiles.save(pending, true);
  await store.put(existing.credentialId, Keypair.generate().secretKey);
  await store.put(pending.credentialId, session.secretKey);
  t.mock.method(NordReads.prototype, "validateNetwork", async () => {});
  t.mock.method(NordReads.prototype, "timestamp", async () => 1700000000);
  t.mock.method(NordReads.prototype, "get", async (path: string) => {
    assert.equal(path, "/account/7/pubkey");
    return existing.owner;
  });
  const user = t.mock.method(NordReads.prototype, "user", async () => {
    const p = profiles.load(existing.name, true) ?? pending;
    return {
      accountIds: ["7"],
      sessions: {
        "43": {
          pubkey: p.sessionPublicKey,
          expiry: new Date(p.expiry * 1000).toISOString(),
          refreshDeadline: new Date(p.deadline * 1000).toISOString(),
        },
      },
    };
  });
  const revoke = t.mock.method(Runtime.prototype, "revoke", async () => ({
    revoked: true,
  }));
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Network is forbidden in setup fixture");
  });
  const options: SetupOptions = {
    profile: existing.name,
    method: "keyfile",
    network: "devnet",
    storage: "file",
    ownerKeyfile,
    accountId: "7",
  };
  return { profiles, store, existing, pending, options, user, revoke, fetch };
}

for (const damage of ["missing", "corrupt", "mismatched"] as const) {
  test(`recovery refuses a ${damage} pending key before replacing or revoking an active session`, async (t) => {
    const f = await fixture(t);
    if (damage === "missing") await f.store.delete(f.pending.credentialId);
    else
      await f.store.put(
        f.pending.credentialId,
        damage === "corrupt"
          ? new Uint8Array([1])
          : Keypair.generate().secretKey,
      );
    await assert.rejects(setup(f.profiles, f.options));
    assert.deepEqual(f.profiles.load(f.existing.name), f.existing);
    assert.equal(
      f.profiles.load(f.existing.name, true)?.credentialId,
      f.pending.credentialId,
    );
    assert.equal(f.revoke.mock.callCount(), 0);
    assert.equal(f.fetch.mock.callCount(), 0);
  });
}

test("another replacement cannot discard an unrevoked predecessor", async (t) => {
  const f = await fixture(t);
  const existing = {
    ...f.existing,
    predecessor: {
      ...f.pending.predecessor!,
      credentialId: randomUUID(),
      sessionId: "41",
    },
  };
  f.profiles.save(existing);
  f.profiles.clearPending(existing.name);
  await assert.rejects(setup(f.profiles, f.options), {
    code: "PREDECESSOR_ACCESS_UNVERIFIED",
  });
  assert.deepEqual(f.profiles.load(existing.name), existing);
  assert.equal(f.profiles.load(existing.name, true), undefined);
  assert.equal(f.revoke.mock.callCount(), 0);
  assert.equal(f.fetch.mock.callCount(), 0);
});

test("interrupted setup recovers the verified session without owner signing or resubmission", async (t) => {
  const f = await fixture(t);
  const result = (await setup(f.profiles, f.options)) as { sessionId: string };
  assert.equal(result.sessionId, "43");
  assert.equal(
    f.profiles.load(f.existing.name)?.credentialId,
    f.pending.credentialId,
  );
  assert.equal(f.profiles.load(f.existing.name)?.predecessor, undefined);
  assert.equal(f.profiles.load(f.existing.name, true), undefined);
  assert.equal(f.revoke.mock.callCount(), 1);
  await assert.rejects(f.store.get(f.existing.credentialId));
  assert.equal(f.fetch.mock.callCount(), 0);
});

test("history lag retains unresolved authorization and never sends another owner authorization", async (t) => {
  const f = await fixture(t);
  f.user.mock.mockImplementation(async () => ({
    accountIds: ["7"],
    sessions: {},
  }));
  await assert.rejects(setup(f.profiles, f.options), {
    code: "UNKNOWN_AUTHORIZATION_OUTCOME",
  });
  assert.deepEqual(f.profiles.load(f.existing.name), f.existing);
  assert.equal(
    f.profiles.load(f.existing.name, true)?.authorizationState,
    "submitting",
  );
  assert.equal(f.revoke.mock.callCount(), 0);
  assert.equal(f.fetch.mock.callCount(), 0);
});

test("declining authorization preserves its cancellation error and never submits", async (t) => {
  const f = await fixture(t);
  f.profiles.save({ ...f.pending, authorizationState: undefined }, true);
  f.user.mock.mockImplementation(async () => ({
    accountIds: ["7"],
    sessions: {},
  }));
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });
  const prompt = t.mock.method(readline, "createInterface", () => ({
    question: async () => "no",
    close() {},
  }));
  syncBuiltinESMExports();
  try {
    await assert.rejects(setup(f.profiles, f.options), {
      code: "AUTHORIZATION_CANCELLED",
    });
    assert.equal(f.fetch.mock.callCount(), 0);
    assert.notEqual(
      f.profiles.load(f.pending.name, true)?.authorizationState,
      "submitting",
    );
    assert.deepEqual(f.profiles.load(f.existing.name), f.existing);
  } finally {
    prompt.mock.restore();
    syncBuiltinESMExports();
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
});

import test from "node:test";
import { request } from "node:http";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { signAsync } from "@noble/ed25519";
import { browserApproval } from "../src/browser-auth";

test("browser binds signature to exact pending message, owner, origin and single-use token", async () => {
  const key = Keypair.generate(),
    message = new TextEncoder().encode("fixed fixture Nord authorization");
  const bridge = await browserApproval(
    async (owner, sign) => {
      const signature = await sign(message, {
        owner,
        network: "devnet",
        accountId: "1",
        sessionPublicKey: "fixture",
        expiry: 123,
        deadline: 456,
        storage: "file",
      });
      assert.equal(signature.length, 64);
      return { authorized: true };
    },
    { open: false, timeoutMs: 5000 },
  );
  const url = new URL(bridge.url),
    token = url.hash.slice(1);
  const headers = {
    Origin: url.origin,
    "Content-Type": "application/json",
    "X-Nord-Setup-Token": token,
  };
  const post = (path: string, data: unknown, extra = {}) =>
    fetch(url.origin + path, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(data),
    });
  try {
    assert.equal(
      (
        await post(
          "/connect",
          { owner: key.publicKey.toBase58() },
          { Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          "/connect",
          { owner: key.publicKey.toBase58() },
          { "X-Nord-Setup-Token": "wrong" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await post("/connect", { owner: key.publicKey.toBase58() })).status,
      200,
    );
    assert.equal(
      (await post("/connect", { owner: key.publicKey.toBase58() })).status,
      409,
    );
    assert.equal(
      (
        await post("/approve", {
          owner: key.publicKey.toBase58(),
          signature: Buffer.alloc(64).toString("base64"),
        })
      ).status,
      403,
    );
    const state = (await (
      await fetch(url.origin + "/state", { headers })
    ).json()) as { message: string };
    assert.equal(state.message, Buffer.from(message).toString("base64"));
    const signature = await signAsync(message, key.secretKey.slice(0, 32));
    assert.equal(
      (
        await post("/approve", {
          owner: key.publicKey.toBase58(),
          signature: Buffer.from(signature).toString("base64"),
        })
      ).status,
      200,
    );
    assert.deepEqual(await bridge.completed, { authorized: true });
    await assert.rejects(post("/approve", {}));
  } finally {
    bridge.close();
  }
});
test("browser listener times out and closes without authorization", async () => {
  const bridge = await browserApproval(
    async () => assert.fail("Must not authorize"),
    { open: false, timeoutMs: 30 },
  );
  await assert.rejects(bridge.completed, /expired/);
  await assert.rejects(fetch(new URL(bridge.url).origin + "/state"));
});

// Hold request bodies until the server has accepted their headers to exercise
// callbacks that overlap across the body's asynchronous read.
async function heldPost(
  url: URL,
  path: string,
  headers: Record<string, string>,
  data: unknown,
) {
  const payload = JSON.stringify(data);
  let send!: () => void;
  let ready!: () => void;
  const accepted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const response = new Promise<number>((resolve, reject) => {
    const req = request(
      new URL(path, url),
      {
        method: "POST",
        headers: {
          ...headers,
          Expect: "100-continue",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      },
    );
    req.on("error", reject);
    req.on("continue", ready);
    send = () => req.end(payload);
    req.flushHeaders();
  });
  await accepted;
  return { send, response };
}

test("overlapping connect bodies cannot select two wallets or authorize twice", async () => {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const owners: string[] = [];
  const bridge = await browserApproval(
    async (owner) => {
      owners.push(owner);
      await finished;
      return {};
    },
    { open: false, timeoutMs: 5000 },
  );
  const url = new URL(bridge.url);
  const headers = {
    Origin: url.origin,
    "Content-Type": "application/json",
    "X-Nord-Setup-Token": url.hash.slice(1),
  };
  const first = Keypair.generate().publicKey.toBase58();
  const winner = Keypair.generate().publicKey.toBase58();
  try {
    const held = await heldPost(url, "/connect", headers, { owner: first });
    assert.equal(
      (
        await fetch(url.origin + "/connect", {
          method: "POST",
          headers,
          body: JSON.stringify({ owner: winner }),
        })
      ).status,
      200,
    );
    held.send();
    assert.equal(await held.response, 409);
    assert.deepEqual(owners, [winner]);
  } finally {
    finish();
    await bridge.completed;
    bridge.close();
  }
});

for (const phase of ["body", "verification"] as const) {
  test(`overlapping approvals consume the challenge only once during ${phase}`, async () => {
    const key = Keypair.generate();
    const message = new TextEncoder().encode("concurrent fixture approval");
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let authorizations = 0;
    const bridge = await browserApproval(
      async (owner, sign) => {
        await sign(message, {
          owner,
          network: "devnet",
          accountId: "7",
          sessionPublicKey: "fixture",
          expiry: 1,
          deadline: 2,
          storage: "file",
        });
        authorizations++;
        await finished;
        return {};
      },
      { open: false, timeoutMs: 5000 },
    );
    const url = new URL(bridge.url);
    const headers = {
      Origin: url.origin,
      "Content-Type": "application/json",
      "X-Nord-Setup-Token": url.hash.slice(1),
    };
    try {
      await fetch(url.origin + "/connect", {
        method: "POST",
        headers,
        body: JSON.stringify({ owner: key.publicKey.toBase58() }),
      });
      const data = {
        owner: key.publicKey.toBase58(),
        signature: Buffer.from(
          await signAsync(message, key.secretKey.slice(0, 32)),
        ).toString("base64"),
      };
      const held = await heldPost(url, "/approve", headers, data);
      if (phase === "body") {
        assert.equal(
          (
            await fetch(url.origin + "/approve", {
              method: "POST",
              headers,
              body: JSON.stringify(data),
            })
          ).status,
          200,
        );
        held.send();
        assert.equal(await held.response, 409);
      } else {
        const second = await heldPost(url, "/approve", headers, data);
        held.send();
        second.send();
        assert.deepEqual(
          (await Promise.all([held.response, second.response])).sort(),
          [200, 409],
        );
      }
      assert.equal(authorizations, 1);
    } finally {
      finish();
      await bridge.completed;
      bridge.close();
    }
  });
}

test("browser serves bundled styles without weakening its content security policy", async () => {
  const bridge = await browserApproval(
    async () => assert.fail("Must not authorize"),
    {
      open: false,
      assets: resolve("src"),
    },
  );
  try {
    const origin = new URL(bridge.url).origin;
    const css = await fetch(origin + "/browser.css");
    assert.equal(css.status, 200);
    assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(await css.text(), await readFile("src/browser.css", "utf8"));
    const policy = css.headers.get("content-security-policy")!;
    assert.match(policy, /style-src 'self'/);
    assert.doesNotMatch(policy, /unsafe-inline|https:/);
    const html = await (await fetch(origin)).text();
    assert.match(html, /href="\/browser.css"/);
    assert.equal((await fetch(origin + "/browser.css?unexpected")).status, 403);
    assert.equal((await fetch(origin + "/state")).status, 403);
  } finally {
    bridge.close();
  }
});

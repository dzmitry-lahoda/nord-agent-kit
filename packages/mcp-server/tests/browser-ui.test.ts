import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const { build } = createRequire(import.meta.url)(
  "esbuild",
) as typeof import("esbuild");

const bundle = build({
  entryPoints: ["src/browser.ts"],
  bundle: true,
  write: false,
  format: "iife",
  plugins: [
    {
      name: "wallet-fixture",
      setup(plugin) {
        plugin.onResolve({ filter: /^@wallet-standard\/app$/ }, () => ({
          path: "wallet-fixture",
          namespace: "fixture",
        }));
        plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents:
            "export const getWallets = () => globalThis.walletRegistry;",
        }));
      },
    },
  ],
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
class Element {
  textContent = "";
  hidden = true;
  disabled = false;
  focused = false;
  dataset: Record<string, string> = {};
  childNodes: Element[] = [];
  onclick?: () => void;
  replaceChildren() {
    this.childNodes = [];
  }
  append(...children: Element[]) {
    this.childNodes.push(...children);
  }
  focus() {
    this.focused = true;
  }
}
const parameters = {
  owner: "owner",
  network: "devnet",
  accountId: "9007199254740993",
  sessionPublicKey: "session-public-key",
  expiry: 1800000000,
  deadline: 1800500000,
  storage: "keyring",
};
async function fixture(options: { noWallet?: boolean; token?: string } = {}) {
  const elements = Object.fromEntries(
    [
      "status",
      "error",
      "approve",
      "wallets",
      "parameters",
      "cancel",
      "step",
      "heading",
      "description",
      "flow",
      "actions",
      "wallet-selection",
      "connected-wallet",
      "wallet-help",
      "network",
      "account",
      "owner",
      "session-key",
      "expiry",
      "deadline",
      "storage",
    ].map((id) => [id, new Element()]),
  );
  const calls: string[] = [];
  const account = {
    address: "owner",
    chains: ["solana:devnet"],
    features: ["solana:signMessage"],
  };
  const state = {
    state: "approve",
    message: btoa("authorization"),
    parameters: { ...parameters },
  };
  const control = {
    reject: false,
    offline: false,
    signatures: 0,
    connect: async () => ({ accounts: [account] }),
    sign: async (message: Uint8Array) => [
      { signedMessage: message, signature: new Uint8Array(64) },
    ],
  };
  const wallet = {
    name: "Fixture wallet",
    features: {
      "standard:connect": { connect: () => control.connect() },
      "solana:signMessage": {
        signMessage: async ({ message }: { message: Uint8Array }) => {
          control.signatures++;
          if (control.reject) throw new Error("User rejected signature");
          return control.sign(message);
        },
      },
    },
  };
  const wallets = options.noWallet ? [] : [wallet];
  const events: Record<string, () => void> = {};
  let tick: () => void = () => {};
  runInNewContext((await bundle).outputFiles![0]!.text, {
    location: { hash: options.token ?? "#test-token" },
    history: { replaceState() {} },
    document: {
      querySelector: (id: string) => elements[id.slice(1)],
      createElement: () => new Element(),
    },
    walletRegistry: {
      get: () => wallets,
      on: (event: string, listener: () => void) => {
        events[event] = listener;
      },
    },
    Uint8Array,
    Error,
    atob,
    btoa,
    fetch: async (path: string) => {
      calls.push(path);
      if (control.offline) throw new Error("Listener closed");
      return { ok: true, json: async () => (path === "/state" ? state : {}) };
    },
    setInterval: (callback: () => void) => {
      tick = callback;
      return 1;
    },
    clearInterval() {},
  });
  return {
    elements,
    calls,
    control,
    state,
    wallets,
    wallet,
    events,
    tick: async () => {
      tick();
      await flush();
    },
    connect: async () => {
      elements.wallets!.childNodes[0]!.onclick!();
      await flush();
    },
  };
}

test("wallet rejection is retryable but successful browser approval cannot be repeated", async () => {
  const f = await fixture();
  f.control.reject = true;
  await f.connect();
  assert.match(f.elements.status!.textContent, /terminal/);
  await f.tick();
  const approve = f.elements.approve!;
  assert.equal(approve.hidden, false);
  approve.onclick!();
  await flush();
  assert.equal(approve.disabled, false);
  assert.match(f.elements.error!.textContent, /User rejected/);
  assert.equal(f.calls.filter((p) => p === "/approve").length, 0);
  f.control.reject = false;
  approve.onclick!();
  approve.onclick!();
  await flush();
  assert.equal(approve.disabled, true);
  assert.equal(approve.hidden, true);
  assert.equal(f.elements.error!.textContent, "");
  assert.equal(f.elements.actions!.hidden, true);
  approve.onclick!();
  await f.tick();
  assert.equal(f.calls.filter((p) => p === "/approve").length, 1);
  assert.equal(f.control.signatures, 2);
  assert.equal(f.elements.heading!.textContent, "Signature returned");
  assert.match(
    f.elements.status!.textContent,
    /CLI for Nord authorization verification/,
  );
  assert.equal(f.elements.heading!.focused, true);
});

test("review preserves full identifiers, UTC deadlines and mainnet/file warnings", async () => {
  const f = await fixture();
  f.state.parameters.network = "mainnet";
  f.state.parameters.storage = "file";
  await f.connect();
  await f.tick();
  assert.equal(f.elements.account!.textContent, parameters.accountId);
  assert.equal(f.elements.owner!.textContent, parameters.owner);
  assert.equal(
    f.elements["session-key"]!.textContent,
    parameters.sessionPublicKey,
  );
  assert.match(f.elements.network!.textContent, /Mainnet · Real funds/);
  assert.match(f.elements.storage!.textContent, /Not encrypted/);
  assert.match(f.elements.expiry!.textContent, /UTC/);
  assert.match(f.elements.deadline!.textContent, /UTC/);
  assert.notEqual(
    f.elements.expiry!.textContent,
    f.elements.deadline!.textContent,
  );
});

test("wallet discovery updates the empty state and duplicate clicks connect only once", async () => {
  const f = await fixture({ noWallet: true });
  assert.equal(f.elements["wallet-help"]!.hidden, false);
  f.wallets.push(f.wallet);
  f.events.register!();
  assert.equal(f.elements["wallet-help"]!.hidden, true);
  const button = f.elements.wallets!.childNodes[0]!;
  button.onclick!();
  button.onclick!();
  await flush();
  assert.equal(f.calls.filter((p) => p === "/connect").length, 1);
});

test("rejected wallet connection remains retryable", async () => {
  const f = await fixture();
  const connect = f.control.connect;
  f.control.connect = async () => {
    throw new Error("Connection rejected");
  };
  await f.connect();
  assert.match(f.elements.error!.textContent, /Connection rejected/);
  assert.equal(f.elements.wallets!.childNodes[0]!.disabled, false);
  f.control.connect = connect;
  await f.connect();
  await f.tick();
  assert.equal(f.elements.approve!.hidden, false);
  assert.equal(f.elements.error!.textContent, "");
});

test("a mismatched owner never exposes an approval action", async () => {
  const f = await fixture();
  await f.connect();
  f.state.parameters.owner = "different-owner";
  await f.tick();
  assert.equal(f.elements.approve!.hidden, true);
  assert.match(f.elements.error!.textContent, /Wallet does not match/);
});

test("cancellation wins over a late wallet signature", async () => {
  const f = await fixture();
  await f.connect();
  await f.tick();
  let release!: () => void;
  f.control.sign = (message) =>
    new Promise((resolve) => {
      release = () =>
        resolve([{ signedMessage: message, signature: new Uint8Array(64) }]);
    });
  f.elements.approve!.onclick!();
  await flush();
  f.elements.cancel!.onclick!();
  await flush();
  release();
  await flush();
  await f.tick();
  assert.equal(f.elements.heading!.textContent, "Setup cancelled");
  assert.equal(f.calls.includes("/approve"), false);
  assert.equal(f.elements.approve!.hidden, true);
});

test("cancellation wins over a late wallet connection", async () => {
  const f = await fixture();
  const connect = f.control.connect;
  let release!: () => void;
  f.control.connect = () =>
    new Promise((resolve) => {
      release = () => void connect().then(resolve);
    });
  f.elements.wallets!.childNodes[0]!.onclick!();
  await flush();
  f.elements.cancel!.onclick!();
  await flush();
  release();
  await flush();
  assert.equal(f.calls.includes("/connect"), false);
  assert.equal(f.elements.heading!.textContent, "Setup cancelled");
});

test("closed listener before connection and missing token give actionable terminal guidance", async () => {
  const f = await fixture();
  f.control.offline = true;
  await f.tick();
  assert.equal(f.elements.heading!.textContent, "Check your terminal");
  assert.equal(f.elements.actions!.hidden, true);
  const missing = await fixture({ token: "" });
  await missing.tick();
  assert.equal(missing.elements.heading!.textContent, "Setup link unavailable");
  assert.equal(missing.calls.length, 0);
});

test("cancel failure reports uncertainty and disables further callbacks", async () => {
  const f = await fixture();
  await f.connect();
  await f.tick();
  f.control.offline = true;
  f.elements.cancel!.onclick!();
  await flush();
  assert.equal(
    f.elements.description!.textContent,
    "Cancellation could not be confirmed.",
  );
  f.elements.approve!.onclick!();
  await flush();
  assert.equal(f.calls.includes("/approve"), false);
});

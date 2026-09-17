import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";

type Approval = {
  message: string;
  parameters: {
    owner: string;
    network: string;
    accountId: string;
    sessionPublicKey: string;
    expiry: number;
    deadline: number;
    storage: string;
  };
};
const token = location.hash.slice(1);
history.replaceState(null, "", "/");
const element = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;
const status = element("status");
const errorMessage = element("error");
const approve = element("approve") as HTMLButtonElement;
const cancel = element("cancel") as HTMLButtonElement;
let selected: { wallet: Wallet; account: WalletAccount } | undefined;
let pending: Approval | undefined;
let stopped = false;
let connecting = false;
let cancelling = false;
let polling = false;
async function api(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Nord-Setup-Token": token,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(
      "Setup request was rejected. Check the CLI and restart setup if needed.",
    );
  return response.json();
}
function report(error: unknown) {
  if (stopped) return;
  errorMessage.textContent =
    error instanceof Error ? error.message : "Wallet request failed.";
}
function heading(step: string, title: string, description: string) {
  element("step").textContent = step;
  element("heading").textContent = title;
  element("description").textContent = description;
}
function finish(title: string, description: string, message: string) {
  stopped = true;
  approve.disabled = true;
  approve.hidden = true;
  cancel.disabled = true;
  element("flow").hidden = true;
  element("actions").hidden = true;
  errorMessage.textContent = "";
  heading("Return to your terminal", title, description);
  status.textContent = message;
  element("heading").focus();
}
function wallets() {
  const host = element("wallets");
  host.replaceChildren();
  for (const wallet of getWallets().get()) {
    if (
      !wallet.features["standard:connect"] ||
      !wallet.features["solana:signMessage"]
    )
      continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wallet";
    button.disabled = connecting || !!selected || stopped || cancelling;
    const name = document.createElement("span");
    name.textContent = wallet.name;
    const action = document.createElement("span");
    action.textContent = "Connect →";
    button.append(name, action);
    button.onclick = () =>
      void (async () => {
        if (connecting || selected || stopped || cancelling) return;
        connecting = true;
        wallets();
        errorMessage.textContent = "";
        status.textContent = `Open ${wallet.name} to connect your wallet.`;
        try {
          const feature = wallet.features["standard:connect"] as {
            connect(): Promise<{ accounts: readonly WalletAccount[] }>;
          };
          const { accounts } = await feature.connect();
          if (stopped || cancelling) return;
          const account = accounts.find(
            (a) =>
              a.chains.some((chain) => chain.startsWith("solana:")) &&
              a.features.includes("solana:signMessage"),
          );
          if (!account)
            throw new Error(
              "This wallet account cannot sign Solana messages. Hardware transaction signing is unsupported in v1.",
            );
          await api("/connect", { owner: account.address });
          if (stopped || cancelling) return;
          selected = { wallet, account };
          element("wallet-selection").hidden = true;
          element("connected-wallet").hidden = false;
          element("connected-wallet").textContent = `${wallet.name} connected`;
          heading(
            "Step 2 of 2 · Review",
            "Review session access",
            "Check the account and access below before approving a message in your wallet.",
          );
          status.textContent =
            "Waiting for session details. Check your terminal to select a Nord account if prompted.";
        } catch (error) {
          if (!stopped) status.textContent = "Choose a wallet to try again.";
          report(error);
        } finally {
          connecting = false;
          wallets();
        }
      })();
    host.append(button);
  }
  element("wallet-help").hidden = host.childNodes.length > 0;
}
function showApproval(state: Approval) {
  if (!selected || pending) return;
  if (state.parameters.owner !== selected.account.address)
    throw new Error(
      "Wallet does not match the requested authorization. Restart setup from your terminal.",
    );
  pending = state;
  const p = state.parameters;
  element("network").textContent =
    p.network === "mainnet"
      ? "Mainnet · Real funds"
      : p.network === "devnet"
        ? "Devnet · Test funds"
        : p.network;
  element("network").dataset.network = p.network;
  element("account").textContent = p.accountId;
  element("owner").textContent = p.owner;
  element("session-key").textContent = p.sessionPublicKey;
  const date = (seconds: number) =>
    new Date(seconds * 1000).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "long",
      timeZone: "UTC",
    });
  element("expiry").textContent = date(p.expiry);
  element("deadline").textContent = date(p.deadline);
  element("storage").textContent =
    p.storage === "keyring"
      ? "OS credential store"
      : p.storage === "file"
        ? "Local file · Not encrypted by this package"
        : p.storage;
  element("parameters").hidden = false;
  approve.hidden = false;
  status.textContent =
    "Ready to approve. Your wallet will ask you to sign a session authorization message.";
}
approve.onclick = () =>
  void (async () => {
    if (stopped || cancelling || approve.disabled) return;
    if (
      !selected ||
      !pending ||
      selected.account.address !== pending.parameters.owner
    )
      throw new Error("Wallet does not match the requested authorization.");
    approve.disabled = true;
    approve.textContent = "Waiting for your wallet…";
    errorMessage.textContent = "";
    status.textContent =
      "Confirm the authorization message in your wallet. You can reject it to return here.";
    try {
      const message = Uint8Array.from(atob(pending.message), (c) =>
        c.charCodeAt(0),
      );
      const feature = selected.wallet.features["solana:signMessage"] as {
        signMessage(input: {
          account: WalletAccount;
          message: Uint8Array;
        }): Promise<{ signature: Uint8Array; signedMessage: Uint8Array }[]>;
      };
      const [result] = await feature.signMessage({
        account: selected.account,
        message,
      });
      // Cancellation or a closed listener must win over a late wallet response.
      if (stopped || cancelling) return;
      if (
        !result ||
        result.signedMessage.length !== message.length ||
        result.signedMessage.some((byte, i) => byte !== message[i])
      )
        throw new Error("Wallet changed the authorization message.");
      await api("/approve", {
        owner: selected.account.address,
        signature: btoa(String.fromCharCode(...result.signature)),
      });
      if (!stopped)
        finish(
          "Signature returned",
          "Finish setup in your terminal",
          "Your signature was sent to the local CLI. Check the CLI for Nord authorization verification before using this profile. You can close this tab.",
        );
    } finally {
      if (!stopped) {
        approve.disabled = cancelling;
        approve.textContent = "Approve in wallet";
        status.textContent =
          "Review the session and approve in your wallet when ready.";
      }
    }
  })().catch(report);
cancel.onclick = () =>
  void (async () => {
    if (stopped || cancelling) return;
    cancelling = true;
    cancel.disabled = true;
    cancel.textContent = "Cancelling…";
    wallets();
    try {
      await api("/cancel", {});
      finish(
        "Setup cancelled",
        "Return to your terminal to start a new setup whenever you’re ready.",
        "If you already approved a wallet message, check the CLI for the session’s status. Closing this page does not revoke an existing session.",
      );
    } catch {
      finish(
        "Check your terminal",
        "Cancellation could not be confirmed.",
        "Check the CLI for the setup result before trying again. Closing this page does not revoke an existing session.",
      );
    }
  })();
getWallets().on("register", wallets);
getWallets().on("unregister", wallets);
wallets();
if (!token)
  finish(
    "Setup link unavailable",
    "This page needs the private setup link generated by the CLI.",
    "Start browser setup again in your terminal and open the new URL. Reloading this page removes access to the previous setup link.",
  );
const interval = setInterval(() => {
  if (stopped) {
    clearInterval(interval);
    return;
  }
  if (polling) return;
  polling = true;
  void api("/state")
    .then(
      (state) => {
        if (stopped || cancelling) return;
        if (state.state === "approve") showApproval(state);
      },
      () => {
        if (!stopped && !cancelling)
          finish(
            "Check your terminal",
            "The local setup connection is no longer available.",
            "Setup may have completed, expired, or stopped. Check the CLI for the result before starting again.",
          );
      },
    )
    .catch(report)
    .finally(() => {
      polling = false;
    });
}, 700);

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { PublicKey } from "@solana/web3.js";
import { verifyAsync } from "@noble/ed25519";
import { z } from "zod";
import { fail, publicError } from "./errors";

type Display = {
  owner: string;
  network: string;
  accountId: string;
  sessionPublicKey: string;
  expiry: number;
  deadline: number;
  storage: string;
};
export type BrowserSigner = (
  message: Uint8Array,
  display: Display,
) => Promise<Uint8Array>;
export async function browserApproval(
  authorize: (owner: string, sign: BrowserSigner) => Promise<unknown>,
  options: { open?: boolean; timeoutMs?: number; assets?: string } = {},
): Promise<{ url: string; completed: Promise<unknown>; close: () => void }> {
  const token = randomBytes(32).toString("hex");
  let origin = "",
    owner: string | undefined,
    used = false,
    closed = false;
  let challenge:
    | {
        message: Uint8Array;
        display: Display;
        resolve: (signature: Uint8Array) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let settle!: (result: unknown) => void, reject!: (error: unknown) => void;
  const completed = new Promise<unknown>((res, rej) => {
    settle = res;
    reject = rej;
  });
  // Attach an observer immediately; callers can begin awaiting after opening a browser.
  void completed.catch(() => undefined);
  const assets = options.assets ?? dirname(fileURLToPath(import.meta.url));
  function json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  }
  async function body(req: IncomingMessage): Promise<unknown> {
    if (req.headers["content-type"] !== "application/json")
      fail("INVALID_CALLBACK", "Expected JSON.");
    const chunks: Buffer[] = [];
    let count = 0;
    for await (const chunk of req) {
      count += chunk.length;
      if (count > 8192)
        fail("INVALID_CALLBACK", "Callback exceeds size limit.");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const server = createServer(
    (req, res) =>
      void (async () => {
        if (
          closed ||
          req.headers.host !== new URL(origin).host ||
          (req.headers.origin !== undefined && req.headers.origin !== origin)
        )
          return json(res, 403, { error: "Invalid loopback origin or host" });
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        );
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        if (
          req.method === "GET" &&
          ["/", "/browser.js", "/browser.css"].includes(req.url ?? "")
        ) {
          const filename = req.url === "/" ? "browser.html" : req.url!.slice(1);
          res.writeHead(200, {
            "Content-Type": filename.endsWith("html")
              ? "text/html; charset=utf-8"
              : filename.endsWith("css")
                ? "text/css; charset=utf-8"
                : "text/javascript; charset=utf-8",
            "Cache-Control": "no-store",
          });
          return res.end(await readFile(join(assets, filename)));
        }
        const supplied = req.headers["x-nord-setup-token"];
        if (
          typeof supplied !== "string" ||
          supplied.length !== token.length ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
        )
          return json(res, 403, { error: "Invalid setup token" });
        if (req.method === "GET" && req.url === "/state")
          return json(
            res,
            200,
            challenge
              ? {
                  state: "approve",
                  message: Buffer.from(challenge.message).toString("base64"),
                  parameters: challenge.display,
                }
              : { state: used ? "submitted" : "waiting" },
          );
        if (req.method !== "POST" || req.headers.origin !== origin)
          return json(res, 403, { error: "Invalid callback origin" });
        if (req.url === "/connect") {
          if (owner || used)
            return json(res, 409, { error: "Wallet already selected" });
          const data = z
            .object({ owner: z.string().max(60) })
            .strict()
            .parse(await body(req));
          // Another callback may have selected a wallet while this body arrived.
          if (closed || owner || used)
            return json(res, 409, {
              error: "Wallet already selected or setup closed",
            });
          owner = new PublicKey(data.owner).toBase58();
          const sign: BrowserSigner = (message, display) =>
            new Promise((resolve, reject) => {
              if (closed || challenge || display.owner !== owner)
                return reject(new Error("Invalid authorization state"));
              challenge = { message, display, resolve, reject };
            });
          void authorize(owner, sign).then(
            (result) => {
              settle(result);
              close();
            },
            (error) => {
              reject(error);
              close();
            },
          );
          return json(res, 200, { connected: true });
        }
        if (req.url === "/approve") {
          if (used || !challenge)
            return json(res, 409, { error: "No pending approval" });
          const pending = challenge;
          const selectedOwner = owner!;
          const data = z
            .object({
              owner: z.string().max(60),
              signature: z.string().max(100),
            })
            .strict()
            .parse(await body(req));
          if (closed || used || challenge !== pending)
            return json(res, 409, {
              error: "Approval already consumed or setup closed",
            });
          const signature = Buffer.from(data.signature, "base64");
          if (
            data.owner !== selectedOwner ||
            signature.length !== 64 ||
            !(await verifyAsync(
              signature,
              pending.message,
              new PublicKey(selectedOwner).toBytes(),
            ))
          )
            return json(res, 403, {
              error: "Signature does not match this authorization and wallet",
            });
          // Verification also yields: atomically claim this exact challenge only
          // after checking it has not been consumed or cancelled in the meantime.
          if (closed || used || challenge !== pending)
            return json(res, 409, {
              error: "Approval already consumed or setup closed",
            });
          used = true;
          challenge = undefined;
          json(res, 200, { approved: true });
          pending.resolve(signature);
          return;
        }
        if (req.url === "/cancel") {
          json(res, 200, { cancelled: true });
          reject(new Error("Wallet authorization cancelled"));
          close();
          return;
        }
        json(res, 404, { error: "Unknown callback" });
      })().catch((error) => {
        if (!res.headersSent) json(res, 400, publicError(error));
        else res.end();
      }),
  );
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 30;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Loopback listener failed");
  origin = `http://127.0.0.1:${address.port}`;
  const timer = setTimeout(() => {
    reject(new Error("Browser setup expired after ten minutes"));
    close();
  }, options.timeoutMs ?? 600000);
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    challenge?.reject(new Error("Browser setup closed"));
    challenge = undefined;
    server.closeAllConnections();
    server.close();
  }
  const url = `${origin}/#${token}`;
  if (options.open !== false) {
    const child = spawn(
      process.platform === "darwin" ? "open" : "xdg-open",
      [url],
      { stdio: "ignore" },
    );
    child.on("error", () =>
      process.stderr.write(
        "Open the setup URL in a browser with a Solana wallet.\n",
      ),
    );
    child.unref();
  }
  return { url, completed, close };
}

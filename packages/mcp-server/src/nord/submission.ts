import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { sizeDelimitedEncode } from "@bufbuild/protobuf/wire";
import { proto, decodeLengthDelimited } from "@n1xyz/nord-ts";
type Action = proto.Action;
type Receipt = proto.Receipt;

/** Unsigned identity suitable for a durable journal. Never includes a signature. */
export interface PreparedActionIdentity {
  unsignedPayload: string;
  hash: string;
  timestamp: string;
  nonce: number;
}

export interface SessionSubmissionHooks {
  /** Must durably finish before any signed request can leave the process. */
  beforeSubmit(identity: PreparedActionIdentity): Promise<void>;
  /** Called before returning success to the caller. */
  afterReceipt(receipt: Receipt): Promise<void>;
}

export class NordSubmissionError extends Error {
  constructor(
    public readonly outcome: "not_submitted" | "rejected" | "unknown",
    public readonly protocolCode?: string,
    public readonly httpStatus?: number,
  ) {
    super(
      outcome === "unknown"
        ? "Nord submission outcome is unknown; reconcile before retrying."
        : `Nord action ${outcome}.`,
    );
    this.name = "NordSubmissionError";
  }
}

export function identifyAction(action: Action): PreparedActionIdentity {
  const bytes = sizeDelimitedEncode(proto.ActionSchema, action);
  return {
    unsignedPayload: Buffer.from(bytes).toString("base64"),
    hash: createHash("sha256").update(bytes).digest("hex"),
    timestamp: action.currentTimestamp.toString(),
    nonce: action.nonce,
  };
}

/** Explicit transport boundary for durable submission; see ../../docs/nord-adapter.md. */
export interface ActionTransport {
  post(body: Uint8Array): Promise<Response>;
}
export function actionTransport(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): ActionTransport {
  const url = new URL("/action", baseUrl);
  return {
    post: (body) =>
      fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(body).buffer,
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      }),
  };
}

/** Caller persists identity first. No signed payload is exposed to persistence hooks. */
export async function sendAction(
  transport: ActionTransport,
  sign: (payload: Uint8Array) => Promise<Uint8Array>,
  action: proto.Action,
): Promise<proto.Receipt> {
  let body: Uint8Array;
  try {
    const payload = sizeDelimitedEncode(proto.ActionSchema, action);
    if (payload.byteLength > 1648)
      throw new Error("Action exceeds protocol payload limit");
    const signature = await sign(payload);
    if (signature.byteLength !== 64)
      throw new Error("Expected an Ed25519 signature");
    body = new Uint8Array([...payload, ...signature]);
  } catch {
    throw new NordSubmissionError("not_submitted");
  }
  try {
    const response = await transport.post(body);
    if (!response.ok)
      throw new NordSubmissionError("unknown", undefined, response.status);
    const receipt = decodeLengthDelimited(
      new Uint8Array(await response.arrayBuffer()),
      proto.ReceiptSchema,
    );
    if (receipt.kind.case === "err") {
      const code = proto.Error[receipt.kind.value];
      throw new NordSubmissionError(
        !code || code.includes("DUPLICATE") ? "unknown" : "rejected",
        code,
      );
    }
    if (!receipt.kind.case) throw new NordSubmissionError("unknown");
    return receipt;
  } catch (error) {
    if (error instanceof NordSubmissionError) throw error;
    throw new NordSubmissionError("unknown");
  }
}

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { PreparedActionIdentity } from "./nord/submission";
import { privatePath, type Profiles } from "./storage";
import { fail } from "./errors";

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export type RequestRecord = {
  id: string;
  identity: string;
  kind: "place" | "cancel" | "renew" | "revoke";
  args: Record<string, unknown>;
  fingerprint: string;
  clientOrderId: string;
  state:
    | "prepared"
    | "submitting"
    | "accepted"
    | "rejected"
    | "not_submitted"
    | "unknown";
  action?: PreparedActionIdentity;
  actionId?: string;
  receipt?: unknown;
  result?: unknown;
  error?: { code: string; message: string };
  cursor: string;
  createdAt: string;
  acceptedAt?: string;
  historyCursor?: string;
  orderId?: string;
  orderLifecycle?: unknown;
};
export class Journal {
  private db: DatabaseSync;
  constructor(profiles: Profiles, name: string) {
    const path = join(profiles.directory(name), "requests.sqlite");
    if (!existsSync(path)) {
      const fd = openSync(path, "wx", 0o600);
      closeSync(fd);
    }
    privatePath(path);
    this.db = new DatabaseSync(path);
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0,
    );
    if (version > 1) {
      this.db.close();
      fail(
        "UNSUPPORTED_JOURNAL_VERSION",
        "Upgrade nord-mcp to read this request journal.",
      );
    }
    this.db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL); PRAGMA user_version=1;",
    );
  }
  close(): void {
    this.db.close();
  }
  get(id: string): RequestRecord | undefined {
    const row = this.db
      .prepare("SELECT record FROM requests WHERE id=?")
      .get(id);
    return row ? JSON.parse(String(row.record)) : undefined;
  }
  save(record: RequestRecord): void {
    this.db
      .prepare(
        "INSERT INTO requests VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,state=excluded.state,record=excluded.record",
      )
      .run(record.id, record.fingerprint, record.state, JSON.stringify(record));
  }
  list(limit = 20, before?: string): RequestRecord[] {
    return this.db
      .prepare(
        "SELECT record FROM requests WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?",
      )
      .all(before ?? null, before ?? null, limit)
      .map((r) => JSON.parse(String(r.record)));
  }
  nonce(): number {
    return Number(
      this.db.prepare("SELECT value FROM metadata WHERE key='nonce'").get()
        ?.value ?? 0,
    );
  }
  beforeSend(id: string, action: PreparedActionIdentity): void {
    const record =
      this.get(id) ??
      fail("REQUEST_NOT_FOUND", "Request journal entry is missing.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO metadata VALUES ('nonce',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(action.nonce);
      this.save({ ...record, action, state: "submitting" });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  begin(
    id: string,
    identity: string,
    kind: RequestRecord["kind"],
    args: Record<string, unknown>,
    cursor: string,
  ): { record: RequestRecord; fresh: boolean } {
    const hash = fingerprint({ identity, kind, args });
    const existing = this.get(id);
    if (existing) {
      if (existing.fingerprint !== hash)
        fail(
          "REQUEST_CONFLICT",
          "This request ID already identifies different arguments or a different account/session. Use requests inspect.",
        );
      return { record: existing, fresh: false };
    }
    const unresolved = this.db
      .prepare(
        "SELECT id FROM requests WHERE fingerprint=? AND state IN ('prepared','submitting','unknown') LIMIT 1",
      )
      .get(hash);
    if (unresolved)
      fail(
        "UNKNOWN_EXECUTION_OUTCOME",
        `This intent is unresolved as ${unresolved.id}. Reconcile that request instead of assigning a new ID.`,
      );
    const record: RequestRecord = {
      id,
      identity,
      kind,
      args,
      fingerprint: hash,
      // Nord's ClientOrderId domain is U63 despite its uint64 protobuf field.
      clientOrderId: (
        randomBytes(8).readBigUInt64BE() &
        ((1n << 63n) - 1n)
      ).toString(),
      state: "prepared",
      cursor,
      createdAt: new Date().toISOString(),
    };
    this.save(record);
    return { record, fresh: true };
  }
  receipt(id: string, actionId: string, receipt: unknown): void {
    const record =
      this.get(id) ??
      fail("REQUEST_NOT_FOUND", "Request journal entry is missing.");
    this.save({ ...record, actionId, receipt, state: "accepted" });
  }
}

import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fail } from "./errors";
import { profileName, profileSchema, type Profile } from "./model";

export function privatePath(path: string, directory = false): void {
  const s = lstatSync(path);
  if (
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o077) !== 0 ||
    (directory ? !s.isDirectory() : !s.isFile())
  ) {
    fail(
      "UNSAFE_STORAGE",
      `Unsafe ownership, permissions, or symlink at ${path}. Use a private directory (0700) and files (0600).`,
    );
  }
}
function rejectSymlinkParents(path: string): void {
  let p = resolve(path);
  while (p !== dirname(p)) {
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())
      fail("UNSAFE_STORAGE", "Storage cannot have symlink components.");
    p = dirname(p);
  }
}
export function privateDirectory(path: string): void {
  rejectSymlinkParents(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  privatePath(path, true);
}
export function atomicWrite(path: string, content: string): void {
  privatePath(dirname(path), true);
  if (lstatSync(path, { throwIfNoEntry: false })) privatePath(path);
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(
    tmp,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    unlinkSync(tmp);
    throw error;
  }
  const dir = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
export function readPrivate(path: string): string {
  privatePath(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export class Profiles {
  readonly root: string;
  constructor(
    root = process.env.NORD_MCP_CONFIG_HOME ??
      join(
        process.env.XDG_CONFIG_HOME ??
          (process.platform === "darwin"
            ? join(homedir(), "Library", "Application Support")
            : join(homedir(), ".config")),
        "nord-mcp",
      ),
  ) {
    if (process.platform !== "darwin" && process.platform !== "linux")
      fail("UNSUPPORTED_PLATFORM", "Use macOS or Linux.");
    this.root = resolve(root);
    privateDirectory(this.root);
  }
  directory(name: string): string {
    const path = join(this.root, profileName.parse(name));
    privateDirectory(path);
    return path;
  }
  path(name: string, pending = false): string {
    return join(
      this.directory(name),
      pending ? "pending.json" : "profile.json",
    );
  }
  load(name: string, pending = false): Profile | undefined {
    const p = this.path(name, pending);
    return existsSync(p)
      ? profileSchema.parse(JSON.parse(readPrivate(p)))
      : undefined;
  }
  require(name: string): Profile {
    return (
      this.load(name) ??
      fail("PROFILE_NOT_FOUND", "Run nord-mcp setup for this profile first.")
    );
  }
  save(profile: Profile, pending = false): void {
    atomicWrite(
      this.path(profile.name, pending),
      JSON.stringify(profileSchema.parse(profile), null, 2),
    );
  }
  clearPending(name: string): void {
    const p = this.path(name, true);
    if (existsSync(p)) {
      privatePath(p);
      unlinkSync(p);
    }
  }
  list(): Profile[] {
    return readdirSync(this.root)
      .filter((name) => profileName.safeParse(name).success)
      .flatMap((name) => {
        try {
          const p = join(this.root, name);
          if (!lstatSync(p).isDirectory()) return [];
          return this.load(name) ?? this.load(name, true) ?? [];
        } catch {
          // Listing is diagnostic; never relax validation or hide a damaged
          // profile behind a successful empty result without a warning.
          process.stderr.write(
            `Profile ${name} could not be read safely and was omitted. Run nord-mcp status --profile ${name} for details.\n`,
          );
          return [];
        }
      });
  }
  remove(name: string): void {
    const p = this.path(name);
    if (existsSync(p)) {
      privatePath(p);
      unlinkSync(p);
    }
    this.clearPending(name);
  }
  lock(name: string): () => void {
    const path = join(this.directory(name), "lock.sqlite");
    if (!existsSync(path)) {
      const fd = openSync(path, "wx", 0o600);
      closeSync(fd);
    }
    privatePath(path);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    } catch {
      db.close();
      return fail(
        "PROFILE_BUSY",
        "Profile in use. Stop its other nord-mcp process before writing.",
      );
    }
    return () => {
      db.exec("ROLLBACK");
      db.close();
    };
  }
}
export interface CredentialStore {
  get(id: string): Promise<Uint8Array>;
  put(id: string, key: Uint8Array): Promise<void>;
  delete(id: string): Promise<void>;
}
export async function credentials(
  profiles: Profiles,
  mode: "keyring" | "file",
): Promise<CredentialStore> {
  if (mode === "file") {
    const root = join(profiles.root, "credentials");
    privateDirectory(root);
    const path = (id: string) => {
      if (!/^[0-9a-f-]{36}$/.test(id))
        fail("INVALID_CREDENTIAL", "Invalid credential reference.");
      return join(root, id);
    };
    return {
      async get(id) {
        return new Uint8Array(Buffer.from(readPrivate(path(id)), "base64"));
      },
      async put(id, key) {
        atomicWrite(path(id), Buffer.from(key).toString("base64"));
      },
      async delete(id) {
        if (existsSync(path(id))) {
          privatePath(path(id));
          unlinkSync(path(id));
        }
      },
    };
  }
  try {
    const { Entry } = await import("@napi-rs/keyring");
    const entry = (id: string) => new Entry("n1xyz.nord-mcp", id);
    return {
      async get(id) {
        try {
          const value = entry(id).getPassword();
          if (!value) throw new Error();
          return new Uint8Array(Buffer.from(value, "base64"));
        } catch {
          return fail(
            "CREDENTIAL_UNAVAILABLE",
            "Unlock your OS credential store and retry.",
          );
        }
      },
      async put(id, key) {
        try {
          entry(id).setPassword(Buffer.from(key).toString("base64"));
        } catch {
          fail(
            "CREDENTIAL_UNAVAILABLE",
            "OS credential storage is unavailable. Unlock it or explicitly select --storage file during setup.",
          );
        }
      },
      async delete(id) {
        try {
          entry(id).deletePassword();
        } catch {
          fail(
            "CREDENTIAL_UNAVAILABLE",
            "Unable to delete the OS credential. Unlock the store and retry.",
          );
        }
      },
    };
  } catch {
    return fail(
      "CREDENTIAL_UNAVAILABLE",
      "OS credential storage is unavailable. Install a supported keyring backend or explicitly select --storage file.",
    );
  }
}

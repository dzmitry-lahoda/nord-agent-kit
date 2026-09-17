import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export function tempRoot(prefix: string): string {
  return mkdtempSync(join(realpathSync(tmpdir()), prefix));
}

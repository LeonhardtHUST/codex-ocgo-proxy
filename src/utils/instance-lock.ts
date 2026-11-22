/**
 * Single-instance coordination per data directory.
 *
 * CLI (`npm start`) and the desktop shell both call `startServer()` against the same
 * `data/` directory, which holds two SQLite databases, the schedulers' state and several
 * caches. Two processes there do not merely fight over a port — they write the same files.
 *
 * So the rule is: **one backend per data directory**, regardless of who starts it. The
 * second starter fails loudly with the holder's PID/kind/port instead of running alongside.
 *
 * Staleness is handled by liveness, not by a timeout: a lock whose PID is gone (crash, kill,
 * container restart) is reclaimed on the next start.
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";

export type InstanceKind = "cli" | "desktop";

export interface InstanceLockRecord {
  /** Owning process id. */
  pid: number;
  /** Who started it, for the error message ("cli" vs "desktop"). */
  kind: InstanceKind;
  /** ISO timestamp, diagnostics only. */
  startedAt: string;
  /** Machine name, so a copied data directory explains itself. */
  host: string;
  /** Listening port once known; absent while the socket is still binding. */
  port?: number;
}

export interface InstanceLockHandle {
  file: string;
  record: InstanceLockRecord;
  /** Record the port once the socket is listening. */
  update(patch: Partial<Pick<InstanceLockRecord, "port">>): void;
  /** Remove the lock, but only if this process still owns it. */
  release(): void;
}

export class InstanceLockedError extends Error {
  readonly code = "INSTANCE_LOCKED";

  constructor(
    readonly holder: InstanceLockRecord,
    readonly file: string,
  ) {
    super(
      `This data directory is already served by a ${holder.kind} instance ` +
        `(pid ${holder.pid}${holder.port ? `, port ${holder.port}` : ""}).`,
    );
    this.name = "InstanceLockedError";
  }
}

export const INSTANCE_LOCK_FILE = "instance.lock";

export function instanceLockPath(dataDir: string): string {
  return resolve(dataDir, INSTANCE_LOCK_FILE);
}

/** Default liveness probe: signal 0 only checks existence (EPERM still means alive). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Parse the lock file; anything unreadable or malformed counts as "no valid lock". */
export function readInstanceLock(file: string): InstanceLockRecord | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const pid = record.pid;
    const kind = record.kind;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    if (kind !== "cli" && kind !== "desktop") return null;
    return {
      pid,
      kind,
      startedAt: typeof record.startedAt === "string" ? record.startedAt : new Date(0).toISOString(),
      host: typeof record.host === "string" ? record.host : "unknown",
      ...(typeof record.port === "number" && Number.isInteger(record.port) ? { port: record.port } : {}),
    };
  } catch {
    return null;
  }
}

export interface AcquireInstanceLockOptions {
  dataDir: string;
  kind: InstanceKind;
  /** Test seam. */
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
  host?: string;
}

/**
 * Take the lock for this data directory, reclaiming a stale one.
 * Throws {@link InstanceLockedError} when a live process already owns it.
 */
export function acquireInstanceLock(options: AcquireInstanceLockOptions): InstanceLockHandle {
  const file = instanceLockPath(options.dataDir);
  const pid = options.pid ?? process.pid;
  const kind = options.kind;
  const isAlive = options.isAlive ?? isProcessAlive;
  const now = options.now ?? (() => new Date());
  const host = options.host ?? hostname();

  mkdirSync(dirname(file), { recursive: true });

  const record: InstanceLockRecord = { pid, kind, startedAt: now().toISOString(), host };

  // Two attempts: the first may lose to a stale lock that gets reclaimed.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // `wx` is atomic: only one process can create the file.
      const fd = openSync(file, "wx");
      try {
        writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
      return makeHandle(file, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readInstanceLock(file);
      // Unreadable or invalid lock: assume the previous owner died mid-write.
      if (!existing) {
        removeIfPresent(file);
        continue;
      }
      if (existing.pid !== pid && isAlive(existing.pid)) {
        throw new InstanceLockedError(existing, file);
      }
      // Same PID can only happen with a stale file from a recycled id; reclaim either way.
      removeIfPresent(file);
    }
  }

  // Second failure means someone re-created the lock between our two attempts.
  const holder = readInstanceLock(file);
  throw holder
    ? new InstanceLockedError(holder, file)
    : Object.assign(new Error(`Could not acquire the instance lock at ${file}`), { code: "INSTANCE_LOCKED" });
}

function removeIfPresent(file: string): void {
  try {
    unlinkSync(file);
  } catch { /* already gone */ }
}

function makeHandle(file: string, record: InstanceLockRecord): InstanceLockHandle {
  let current = record;
  let released = false;

  const persist = () => {
    try {
      writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
    } catch { /* diagnostics only; never fail the server over the lock file */ }
  };

  return {
    file,
    record,
    update(patch) {
      if (released) return;
      current = { ...current, ...patch };
      persist();
    },
    release() {
      if (released) return;
      released = true;
      const onDisk = readInstanceLock(file);
      // Only delete our own lock: a successor may have reclaimed it already.
      if (onDisk && onDisk.pid === current.pid) removeIfPresent(file);
    },
  };
}

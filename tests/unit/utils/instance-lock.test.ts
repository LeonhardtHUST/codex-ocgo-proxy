import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  INSTANCE_LOCK_FILE,
  InstanceLockedError,
  acquireInstanceLock,
  instanceLockPath,
  isProcessAlive,
  readInstanceLock,
} from "@src/utils/instance-lock.js";

const dirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-instance-lock-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const alive = () => true;
const dead = () => false;

describe("instance lock", () => {
  it("records the owner and creates the lock file", () => {
    const dir = tempDataDir();
    const lock = acquireInstanceLock({ dataDir: dir, kind: "cli", pid: 4242, isAlive: alive });
    const file = instanceLockPath(dir);
    expect(lock.file).toBe(file);
    expect(existsSync(file)).toBe(true);

    const record = JSON.parse(readFileSync(file, "utf8")) as { pid: number; kind: string };
    expect(record.pid).toBe(4242);
    expect(record.kind).toBe("cli");
    expect(file.endsWith(INSTANCE_LOCK_FILE)).toBe(true);
  });

  it("refuses a second backend while the owner is alive", () => {
    const dir = tempDataDir();
    acquireInstanceLock({ dataDir: dir, kind: "cli", pid: 4242, isAlive: alive });
    try {
      acquireInstanceLock({ dataDir: dir, kind: "desktop", pid: 777, isAlive: alive });
      throw new Error("expected the second acquire to be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(InstanceLockedError);
      const locked = error as InstanceLockedError;
      expect(locked.code).toBe("INSTANCE_LOCKED");
      expect(locked.holder).toMatchObject({ pid: 4242, kind: "cli" });
      expect(locked.message).toContain("already served by a cli instance");
    }
  });

  it("reclaims a lock whose process is gone", () => {
    const dir = tempDataDir();
    acquireInstanceLock({ dataDir: dir, kind: "cli", pid: 4242, isAlive: alive });
    // Same directory, but the previous owner is dead now.
    const second = acquireInstanceLock({ dataDir: dir, kind: "desktop", pid: 777, isAlive: dead });
    expect(readInstanceLock(instanceLockPath(dir))?.pid).toBe(777);
    second.release();
    expect(existsSync(instanceLockPath(dir))).toBe(false);
  });

  it("reclaims an unparsable lock file", () => {
    const dir = tempDataDir();
    writeFileSync(instanceLockPath(dir), "{ truncated");
    const lock = acquireInstanceLock({ dataDir: dir, kind: "cli", pid: 9, isAlive: alive });
    expect(readInstanceLock(lock.file)?.pid).toBe(9);
  });

  it("rejects a lock record without a usable pid or kind", () => {
    const dir = tempDataDir();
    writeFileSync(instanceLockPath(dir), JSON.stringify({ kind: "cli" }));
    const lock = acquireInstanceLock({ dataDir: dir, kind: "cli", pid: 11, isAlive: alive });
    expect(readInstanceLock(lock.file)?.pid).toBe(11);
  });

  it("reports the port once known", () => {
    const dir = tempDataDir();
    const lock = acquireInstanceLock({ dataDir: dir, kind: "cli", pid: 4242, isAlive: alive });
    lock.update({ port: 18080 });
    expect(readInstanceLock(lock.file)?.port).toBe(18080);

    try {
      acquireInstanceLock({ dataDir: dir, kind: "cli", pid: 777, isAlive: alive });
    } catch (error) {
      expect((error as InstanceLockedError).message).toContain("port 18080");
    }
  });

  it("does not let a late releaser delete a successor's lock", () => {
    const dir = tempDataDir();
    const first = acquireInstanceLock({ dataDir: dir, kind: "cli", pid: 4242, isAlive: alive });
    // Simulate a takeover: the file now belongs to another pid.
    writeFileSync(instanceLockPath(dir), JSON.stringify({ pid: 9999, kind: "desktop", startedAt: new Date().toISOString(), host: "h" }));
    first.release();
    expect(readInstanceLock(instanceLockPath(dir))?.pid).toBe(9999);
  });

  it("is idempotent on release", () => {
    const dir = tempDataDir();
    const lock = acquireInstanceLock({ dataDir: dir, kind: "cli", pid: 4242, isAlive: alive });
    lock.release();
    lock.release();
    expect(existsSync(instanceLockPath(dir))).toBe(false);
  });

  it("probes liveness of real and impossible pids", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    // 2^31-1 is not a live pid on any supported platform.
    expect(isProcessAlive(2_147_483_647)).toBe(false);
  });
});

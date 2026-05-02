// ============================================================
// File-backed registry with lock-based concurrency protection
// ============================================================

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { openSync, closeSync } from "node:fs";
import {
  type DelegateRegistry,
  type DelegateRecord,
  type AllocateOptions,
} from "./types.js";

const REGISTRY_VERSION = 1;
const RETRIES = 50;
const RETRY_DELAY_MS = 20;
const SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function slugify(task: string, existing: Set<string>): string {
  const base = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  let slug = base || "delegate";
  let candidate = slug;
  let count = 1;
  while (existing.has(candidate)) {
    candidate = `${slug}-${count++}`;
  }
  return candidate;
}

function now(): string {
  return new Date().toISOString();
}

export class Registry {
  private registryFile: string;
  private lockFile: string;
  private delegatesDir: string;

  constructor(delegatesDir: string) {
    this.delegatesDir = resolve(delegatesDir);
    this.registryFile = join(this.delegatesDir, "registry.json");
    this.lockFile = `${this.registryFile}.lock`;
  }

  /** Ensure the delegates directory exists */
  async ensureDir(): Promise<void> {
    await mkdir(this.delegatesDir, { recursive: true });
    await mkdir(join(this.delegatesDir, "sessions"), { recursive: true });
  }

  /** Acquire an exclusive lock via fs.open("wx"). */
  private async acquireLock(): Promise<number> {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        const fd = openSync(this.lockFile, "wx");
        return fd;
      } catch {
        if (attempt < RETRIES - 1) {
          await SLEEP(RETRY_DELAY_MS);
        }
      }
    }
    throw new Error(`Failed to acquire registry lock after ${RETRIES} attempts`);
  }

  private releaseLock(fd: number): void {
    try {
      closeSync(fd);
      // Lazily remove the lock file; OK on failure.
      try {
        unlink(this.lockFile).catch(() => {});
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  }

  /** Load the registry from disk, creating an empty one if absent. */
  async load(parentSessionFile: string): Promise<DelegateRegistry> {
    await this.ensureDir();
    try {
      const raw = await readFile(this.registryFile, "utf-8");
      const parsed = JSON.parse(raw) as DelegateRegistry;
      if (parsed.version !== REGISTRY_VERSION) {
        throw new Error(`Unsupported registry version: ${parsed.version}`);
      }
      // Ensure the parentSessionFile is always up-to-date
      parsed.parentSessionFile = parentSessionFile;
      return parsed;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return {
          version: REGISTRY_VERSION,
          parentSessionFile,
          activeDelegateId: null,
          delegates: {},
        };
      }
      throw err;
    }
  }

  /** Atomically save the registry. */
  async save(data: DelegateRegistry): Promise<void> {
    const fd = await this.acquireLock();
    try {
      const tmpFile = `${this.registryFile}.tmp`;
      await writeFile(tmpFile, JSON.stringify(data, null, 2), "utf-8");
      const newRaw = await readFile(tmpFile, "utf-8");
      await writeFile(this.registryFile, newRaw, "utf-8");
      await unlink(tmpFile);
    } finally {
      this.releaseLock(fd);
    }
  }

  /** Register a new delegate record. */
  async allocate(
    registry: DelegateRegistry,
    task: string,
    opts?: AllocateOptions,
  ): Promise<DelegateRecord> {
    const existing = new Set(Object.keys(registry.delegates));
    const id = opts?.id ?? slugify(task, existing);

    const sessionsDir = join(this.delegatesDir, "sessions");
    const slug = `${id}-${Date.now()}`;
    const sessionFile = resolve(sessionsDir, `${slug}.jsonl`);

    const cwd = opts?.asWorktree
      ? join(this.delegatesDir, "worktrees", id)
      : dirname(sessionFile);

    const record: DelegateRecord = {
      id,
      sessionFile,
      cwd,
      branch: undefined,
      task,
      status: "idle",
      createdAt: now(),
      updatedAt: now(),
    };

    registry.delegates[id] = record;
    await this.save(registry);
    return record;
  }

  /** Patch an existing delegate record. */
  async update(registry: DelegateRegistry, id: string, patch: Partial<Omit<DelegateRecord, "id">>): Promise<void> {
    const rec = registry.delegates[id];
    if (!rec) return; // idempotent
    Object.assign(rec, patch, { updatedAt: now() });
    await this.save(registry);
  }

  /** Remove a delegate from the registry. Idempotent. */
  async remove(registry: DelegateRegistry, id: string): Promise<void> {
    delete registry.delegates[id];
    if (registry.activeDelegateId === id) {
      registry.activeDelegateId = null;
    }
    await this.save(registry);
  }

  /** Set the active delegate. Pass null to clear. */
  async setActive(registry: DelegateRegistry, id: string | null): Promise<void> {
    registry.activeDelegateId = id;
    await this.save(registry);
  }

  getActive(registry: DelegateRegistry): DelegateRecord | null {
    if (!registry.activeDelegateId) return null;
    return registry.delegates[registry.activeDelegateId] ?? null;
  }
}

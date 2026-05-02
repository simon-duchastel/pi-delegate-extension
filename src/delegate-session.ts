// ============================================================
// DelegateSessionManager — in-process delegate lifecycle
//
// Wraps createAgentSession() to spawn child AgentSessions,
// subscribes to their events, and proxies assistant text
// back into the parent chat as custom messages.
// ============================================================

import {
  createAgentSession,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionAPI,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import { mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Registry } from "./registry.js";
import type { DelegateRegistry, DelegateRecord } from "./types.js";

export interface SpawnResult {
  delegateId: string;
  sessionFile: string;
  cwd: string;
}

export class DelegateSessionManager {
  private pi: ExtensionAPI;
  private registry: Registry;
  private registryData: DelegateRegistry;
  private delegatesDir: string;
  private gitRoot: string | null;

  /** In-memory map of truly running delegates */
  private activeSessions = new Map<string, AgentSession>();
  private unsubscribers = new Map<string, (() => void)[]>();

  constructor(
    pi: ExtensionAPI,
    registry: Registry,
    registryData: DelegateRegistry,
    delegatesDir: string,
    gitRoot: string | null,
  ) {
    this.pi = pi;
    this.registry = registry;
    this.registryData = registryData;
    this.delegatesDir = delegatesDir;
    this.gitRoot = gitRoot;
  }

  /**
   * Spawn a new in-process delegate.
   *
   * 1. Slugify → dedupe against registry
   * 2. Pick cwd (plain folder or git worktree)
   * 3. Create SessionManager + createAgentSession()
   * 4. Register, subscribe to events, proxy to parent
   * 5. Kick off with delegate.prompt(task)
   */
  async spawn(task: string, opts?: {
    id?: string;
    asWorktree?: boolean;
    model?: any;
  }): Promise<SpawnResult> {
    // --- 1. Generate a unique id ---
    const existing = new Set(Object.keys(this.registryData.delegates));
    const baseSlug =
      opts?.id
        ?.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
      ?? task
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);

    let candidate = baseSlug || "delegate";
    let count = 1;
    while (existing.has(candidate)) {
      candidate = `${baseSlug}-${count++}`;
    }
    const id = candidate;

    // --- 2. Determine cwd & branch ---
    const wantWorktree = opts?.asWorktree ?? false;
    const useWorktree = wantWorktree && this.gitRoot !== null;

    let cwd: string;
    let branch: string | undefined;

    if (useWorktree) {
      cwd = resolve(this.delegatesDir, "worktrees", id);
      branch = `wt/${id}`;
      // Actual git worktree creation is deferred to a later PR that wires
      // execGit(['worktree', 'add', ...]). For now just ensure folder.
    } else {
      // Plain folder next to session file
      const sessionsDir = resolve(this.delegatesDir, "sessions");
      cwd = resolve(sessionsDir, id);
    }

    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });

    // --- 3. Create a SessionManager + AgentSession ---
    // Session files go inside .pi/delegates/sessions/<id>/
    const sessionDir = resolve(cwd, ".pi", "sessions");
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

    // We need to avoid name collisions with any sibling sessions, so use id
    const sm = SessionManager.create(cwd, sessionDir);
    const sessionFile = sm.getSessionFile();
    if (!sessionFile) {
      throw new Error("Failed to create delegate session file");
    }

    const {
      session: delegate,
    } = await createAgentSession({
      cwd,
      sessionManager: sm,
      model: opts?.model,
    });

    // --- 4. Register in registry ---
    const record: DelegateRecord = {
      id,
      sessionFile,
      cwd,
      branch,
      task,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.registryData.delegates[id] = record;
    await this.registry.save(this.registryData);

    // --- 5. Track in memory ---
    this.activeSessions.set(id, delegate);

    // --- 6. Subscribe + proxy events ---
    const unsubList: (() => void)[] = [];

    const listener = (event: AgentSessionEvent) => {
      switch (event.type) {
        case "message_start": {
          this.registry.update(this.registryData, id, { status: "running" });
          break;
        }
        case "message_end": {
          if (event.message.role === "assistant") {
            const text = extractText(event.message);
            if (text) {
              const truncated =
                text.length > 2000 ? text.slice(0, 2000) + "..." : text;
              this.pi.sendMessage({
                customType: "delegate-output",
                content: `[${id}] ${truncated}`,
                display: true,
              });
            }
          }
          break;
        }
        case "agent_end": {
          this.registry.update(this.registryData, id, { status: "done" });
          break;
        }
      }
    };

    unsubList.push(delegate.subscribe(listener));
    this.unsubscribers.set(id, unsubList);

    // --- 7. Kick off the delegate ---
    await delegate.prompt(task);

    return { delegateId: id, sessionFile, cwd };
  }

  /** Dispose a single active delegate session. */
  dispose(id: string): void {
    const unsubs = this.unsubscribers.get(id);
    if (unsubs) {
      for (const unsub of unsubs) unsub();
      this.unsubscribers.delete(id);
    }
    const session = this.activeSessions.get(id);
    if (session) {
      session.dispose();
      this.activeSessions.delete(id);
    }
  }

  /** Dispose every tracked delegate (used on session_shutdown). */
  disposeAll(): void {
    for (const id of Array.from(this.activeSessions.keys())) {
      this.dispose(id);
    }
  }
}

/** Extract plain text from an AgentMessage content array. */
function extractText(message: any): string {
  if (!message.content) return "";
  const parts = Array.isArray(message.content)
    ? message.content
    : [message.content];
  return parts
    .map((part: any) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && part.type === "text") {
        return part.text ?? "";
      }
      return "";
    })
    .join("");
}

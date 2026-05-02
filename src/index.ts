// ============================================================
// pi-delegate-extension — Parent/Child Session Coordination
//
// PR2: In-process delegate spawning and event proxy
// Built atop PR1: Foundation (registry, types, utilities)
// ============================================================

import type {
  ExtensionAPI,
  AgentSession,
} from "@mariozechner/pi-coding-agent";
import { Registry } from "./registry.js";
import { DelegateSessionManager } from "./delegate-session.js";
import type { DelegateRegistry, SessionMode } from "./types.js";
import { resolveGitRoot } from "./utils.js";
import { resolve, join } from "node:path";

/**
 * Convention: all delegate state lives under `.pi/delegates/` in
 * the current working directory.
 */
function getDelegatesDir(cwd: string): string {
  return resolve(cwd, ".pi", "delegates");
}

/** Compare session file paths robustly. */
function sameFile(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/\/+$/, "") === b.replace(/\\+$/, "");
}

/** Detect whether the current session is parent, child, or unrelated. */
function detectMode(registry: DelegateRegistry, currentSessionFile: string | undefined): SessionMode {
  if (!currentSessionFile) return null;
  if (sameFile(currentSessionFile, registry.parentSessionFile)) {
    return "parent";
  }
  for (const rec of Object.values(registry.delegates)) {
    if (sameFile(currentSessionFile, rec.sessionFile)) {
      return "child";
    }
  }
  return null;
}

export default function majordomo(pi: ExtensionAPI) {
  // --- PR1 state ---
  let registryData: DelegateRegistry | null = null;
  let mode: SessionMode = null;
  let registry: Registry | null = null;
  let gitRoot: string | null = null;

  // --- PR2 state ---
  let delegateManager: DelegateSessionManager | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;
    const delegatesDir = getDelegatesDir(cwd);
    registry = new Registry(delegatesDir);
    gitRoot = await resolveGitRoot(cwd);

    const currentFile = ctx.sessionManager.getSessionFile();
    registryData = await registry.load(
      currentFile ?? resolve(delegatesDir, "sessions", "parent.jsonl"),
    );
    mode = detectMode(registryData, currentFile);

    // PR2: Initialise delegate session manager (in-memory tracking)
    // Only relevant when we are in parent mode — child mode has no delegates
    if (mode === "parent" || mode === null) {
      delegateManager = new DelegateSessionManager(
        pi,
        registry,
        registryData,
        delegatesDir,
        gitRoot,
      );
    }
  });

  // --- PR2: session_shutdown cleanup ---
  pi.on("session_shutdown", async (_event, _ctx) => {
    delegateManager?.disposeAll();
    delegateManager = null;
  });

  // --- PR1: Debug command (kept) ---
  pi.registerCommand("delegate-status", {
    description: "Show delegate registry status (debug)",
    handler: async (_args, ctx) => {
      if (!registryData) {
        ctx.ui.notify("Registry not loaded yet", "error");
        return;
      }
      const lines: string[] = [
        `Mode: ${mode ?? "none"}`,
        `Parent session: ${registryData.parentSessionFile ?? "(none)"}`,
        `Active delegate: ${registryData.activeDelegateId ?? "(none)"}`,
        `Delegates: ${Object.keys(registryData.delegates).length}`,
        ...Object.values(registryData.delegates).map(
          (d) => `  • ${d.id}: ${d.status} (${d.sessionFile})`,
        ),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // --- PR2: /delegate-new command ---
  pi.registerCommand("delegate-new", {
    description: "Spawn a new delegate with a given task",
    handler: async (args: string, ctx) => {
      if (!delegateManager) {
        ctx.ui.notify("Delegate manager not initialized", "error");
        return;
      }
      if (!registryData) {
        ctx.ui.notify("Registry not loaded", "error");
        return;
      }

      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /delegate-new [--worktree] <task>", "warning");
        return;
      }

      const parts = trimmed.split(/\s+/);
      const asWorktree = parts[0] === "--worktree";
      const task = asWorktree ? parts.slice(1).join(" ") : trimmed;

      if (!task.trim()) {
        ctx.ui.notify("Usage: /delegate-new [--worktree] <task>", "warning");
        return;
      }

      ctx.ui.notify(`Spawning delegate: ${task.slice(0, 50)}...`, "info");
      try {
        const result = await delegateManager.spawn(task, {
          asWorktree,
          model: ctx.model,
        });
        ctx.ui.notify(
          `Delegate \`${result.delegateId}\` spawned at ${result.cwd}`,
          "info",
        );
      } catch (e: any) {
        ctx.ui.notify(`Failed to spawn delegate: ${e.message}`, "error");
      }
    },
  });

  // --- PR2: spawn_delegate tool ---
  pi.registerTool({
    name: "spawn_delegate",
    label: "Spawn Delegate",
    description:
      "Create a new delegate session for a task. Returns delegate_id, session_file, and cwd.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Task to delegate to the new agent session",
        },
        id: {
          type: "string",
          description: "Optional custom delegate ID (slug). Auto-generated if omitted.",
        },
        as_worktree: {
          type: "boolean",
          description:
            "Create in a git worktree for isolation. Requires a git repo.",
        },
      },
      required: ["task"],
    } as any,
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      if (!delegateManager || !registryData) {
        return {
          content: [
            { type: "text", text: "Delegate manager not initialized" },
          ],
          isError: true,
          details: {},
        };
      }

      try {
        const result = await delegateManager.spawn(params.task, {
          id: params.id,
          asWorktree: params.as_worktree ?? false,
          model: ctx.model,
        });
        return {
          content: [
            {
              type: "text",
              text: `Spawned delegate \`${result.delegateId}\` at ${result.cwd}`,
            },
          ],
          details: {
            delegate_id: result.delegateId,
            session_file: result.sessionFile,
            cwd: result.cwd,
          },
        };
      } catch (e: any) {
        return {
          content: [
            { type: "text", text: `Failed to spawn delegate: ${e.message}` },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });
}

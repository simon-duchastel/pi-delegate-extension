// ============================================================
// pi-delegate-extension — Parent/Child Session Coordination
//
// PR3: Visibility — Widget, Status Commands, and Viewing
// Built atop PR2: Core (spawning, event proxy)
// ============================================================

import type {
  ExtensionAPI,
  AgentSession,
} from "@mariozechner/pi-coding-agent";
import { Registry } from "./registry.js";
import { DelegateSessionManager } from "./delegate-session.js";
import type { DelegateRegistry, SessionMode } from "./types.js";
import { resolveGitRoot } from "./utils.js";
import { refreshWidget } from "./widget.js";
import { formatDelegateConversation } from "./viewer.js";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { rmdir, unlink, readdir } from "node:fs/promises";

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
  // Captured UI context for widget refreshes outside event handlers
  let currentCtx: any = null;

  // --- PR3: widget refresh helper ---
  function updateWidget(ctx: any): void {
    if (!registryData) return;
    const activeSessions = delegateManager?.getActiveSessions() ?? new Map<string, AgentSession>();
    refreshWidget(ctx, registryData, activeSessions);
  }

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
      currentCtx = ctx;
      delegateManager = new DelegateSessionManager(
        pi,
        registry,
        registryData,
        delegatesDir,
        gitRoot,
        (_id, _status) => {
          updateWidget(currentCtx);
        },
      );
    }

    // PR3: show widget if delegates exist
    if (mode === "parent" || mode === null) {
      updateWidget(ctx);
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
          (d) => `  \u2022 ${d.id}: ${d.status} (${d.sessionFile})`,
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
        // PR3: refresh widget after spawn
        updateWidget(ctx);
      } catch (e: any) {
        ctx.ui.notify(`Failed to spawn delegate: ${e.message}`, "error");
      }
    },
  });

  // --- PR3: /delegate-list command ---
  pi.registerCommand("delegate-list", {
    description: "Show all delegates in an overlay list",
    handler: async (_args, ctx) => {
      if (!registryData) {
        ctx.ui.notify("Registry not loaded", "error");
        return;
      }
      const delegates = Object.values(registryData.delegates);
      if (delegates.length === 0) {
        ctx.ui.notify("No delegates registered", "info");
        return;
      }
      const activeSessions = delegateManager?.getActiveSessions() ?? new Map<string, AgentSession>();
      const items = delegates.map((d) => {
        const isStreaming = activeSessions.get(d.id)?.isStreaming ?? false;
        const status = isStreaming ? "running" : d.status;
        return `${d.id} [${status}]`;
      });
      const choice = await ctx.ui.select("Delegates:", items);
      if (choice) {
        const id = choice.split(" [")[0];
        ctx.ui.notify(`Selected delegate: ${id}`, "info");
      }
    },
  });

  // --- PR3: /delegate-view <id> command ---
  pi.registerCommand("delegate-view", {
    description: "View a delegate's conversation in chat",
    handler: async (args: string, ctx) => {
      if (!registryData) {
        ctx.ui.notify("Registry not loaded", "error");
        return;
      }
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /delegate-view <id>", "warning");
        return;
      }
      const rec = registryData.delegates[id];
      if (!rec) {
        ctx.ui.notify(`No delegate found: ${id}`, "error");
        return;
      }
      try {
        const markdown = await formatDelegateConversation(rec);
        pi.sendMessage({
          customType: "delegate-view",
          content: markdown,
          display: true,
        });
      } catch (e: any) {
        ctx.ui.notify(`Failed to view delegate: ${e.message}`, "error");
      }
    },
  });

  // --- PR3: /delegate-remove <id> command ---
  pi.registerCommand("delegate-remove", {
    description: "Remove a delegate and clean up its files",
    handler: async (args: string, ctx) => {
      if (!registryData || !registry) {
        ctx.ui.notify("Registry not loaded", "error");
        return;
      }
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /delegate-remove <id>", "warning");
        return;
      }
      const rec = registryData.delegates[id];
      if (!rec) {
        ctx.ui.notify(`No delegate found: ${id}`, "error");
        return;
      }
      const ok = await ctx.ui.confirm("Remove Delegate", `Remove \`${id}\` and delete its files?`);
      if (!ok) return;

      // Dispose session if active
      delegateManager?.dispose(id);
      try {
        await removeDelegateArtifacts(rec);
      } catch (e: any) {
        ctx.ui.notify(`Cleanup warning: ${e.message}`, "warning");
      }
      await registry.remove(registryData, id);
      ctx.ui.notify(`Delegate \`${id}\` removed`, "info");
      updateWidget(ctx);
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
        updateWidget(ctx);
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

  // --- PR3: view_delegate tool ---
  pi.registerTool({
    name: "view_delegate",
    label: "View Delegate",
    description: "Read a delegate's session JSONL and inject its conversation into parent chat.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Delegate ID to view",
        },
      },
      required: ["id"],
    } as any,
    async execute(_toolCallId, params: any, _signal, _onUpdate, _ctx) {
      if (!registryData) {
        return {
          content: [{ type: "text", text: "Registry not loaded" }],
          isError: true,
          details: {},
        };
      }
      const rec = registryData.delegates[params.id];
      if (!rec) {
        return {
          content: [{ type: "text", text: `No delegate found: ${params.id}` }],
          isError: true,
          details: {},
        };
      }
      try {
        const markdown = await formatDelegateConversation(rec);
        pi.sendMessage({
          customType: "delegate-view",
          content: markdown,
          display: true,
        });
        return {
          content: [{ type: "text", text: `Injected conversation for \`${params.id}\`.` }],
          details: {},
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed to view delegate: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // --- PR3: remove_delegate tool ---
  pi.registerTool({
    name: "remove_delegate",
    label: "Remove Delegate",
    description: "Kill a delegate session and clean up its files and registry entry.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Delegate ID to remove",
        },
      },
      required: ["id"],
    } as any,
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      if (!registryData || !registry) {
        return {
          content: [{ type: "text", text: "Registry not loaded" }],
          isError: true,
          details: {},
        };
      }
      const rec = registryData.delegates[params.id];
      if (!rec) {
        return {
          content: [{ type: "text", text: `No delegate found: ${params.id}` }],
          isError: true,
          details: {},
        };
      }
      delegateManager?.dispose(params.id);
      try {
        await removeDelegateArtifacts(rec);
      } catch (e: any) {
        // non-fatal: registry still removed below
      }
      await registry.remove(registryData, params.id);
      updateWidget(ctx);
      return {
        content: [{ type: "text", text: `Delegate \`${params.id}\` removed.` }],
        details: {},
      };
    },
  });

  // --- PR3: Message renderer for delegate-output ---
  pi.registerMessageRenderer("delegate-output", (message, _options, theme) => {
    const content = message.content as string;
    const bracketMatch = content.match(/^\[([^\]]+)\]\s*/);
    const id = bracketMatch?.[1] ?? "delegate";
    const rest = bracketMatch ? content.slice(bracketMatch[0].length) : content;
    const styled = `${theme.fg("accent", `[${id}]`)} ${rest}`;
    return { render: () => [styled], invalidate: () => {} } as any;
  });

  // --- PR3: Message renderer for delegate-view ---
  pi.registerMessageRenderer("delegate-view", (message, _options, theme) => {
    const content = message.content as string;
    // Simple markdown-like rendering: headers, bold
    const lines = content.split("\n").map((line) => {
      if (line.startsWith("## ")) {
        return theme.fg("accent", theme.bold(line));
      }
      if (line.startsWith("**") && line.includes(":**")) {
        return line.replace(/\*\*([^*]+)\*\*/g, (_, m) => theme.bold(m));
      }
      return line;
    });
    return { render: () => lines, invalidate: () => {} } as any;
  });
}

// --- PR3: cleanup helper ---
async function removeDelegateArtifacts(rec: { cwd: string; sessionFile?: string }): Promise<void> {
  // Remove session JSONL if exists
  if (rec.sessionFile && existsSync(rec.sessionFile)) {
    await unlink(rec.sessionFile);
    // Remove parent session directory if empty
    try {
      await rmdir(dirname(rec.sessionFile));
    } catch {
      // ignore if not empty
    }
  }
  // Remove cwd contents and directory
  if (rec.cwd && existsSync(rec.cwd)) {
    const entries = await readdir(rec.cwd, { withFileTypes: true, recursive: true });
    // Delete files then dirs (reverse order so children first)
    const files = entries.filter((e) => e.isFile());
    const dirs = entries.filter((e) => e.isDirectory());
    for (const f of files) {
      await unlink(resolve(rec.cwd, f.parentPath ?? "", f.name));
    }
    // Sort dirs by depth descending
    dirs.sort((a, b) => {
      const da = (a.parentPath ?? "").split(/[/\\]/).length;
      const db = (b.parentPath ?? "").split(/[/\\]/).length;
      return db - da;
    });
    for (const d of dirs) {
      try {
        await rmdir(resolve(rec.cwd, d.parentPath ?? "", d.name));
      } catch {
        // ignore
      }
    }
    try {
      await rmdir(rec.cwd);
    } catch {
      // ignore
    }
  }
}

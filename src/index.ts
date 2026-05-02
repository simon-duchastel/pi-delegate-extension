// ============================================================
// pi-delegate-extension — PR1: Foundation
//
// Registry, types, and utilities. Registers session_start to
// initialise (and lazily create) the on-disk delegate registry.
// ============================================================

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Registry } from "./registry.js";
import { type DelegateRegistry, type SessionMode } from "./types.js";
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
  // Normalize trailing slashes and compare case-sensitively
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
  // In-memory registry state (persisted on disk)
  let registry: DelegateRegistry | null = null;
  let mode: SessionMode = null;
  let registryManager: Registry | null = null;
  let gitRoot: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;
    const delegatesDir = getDelegatesDir(cwd);
    registryManager = new Registry(delegatesDir);

    // Resolve git root once; used by later PRs for worktrees
    gitRoot = await resolveGitRoot(cwd);

    const currentFile = ctx.sessionManager.getSessionFile();
    registry = await registryManager.load(currentFile ?? resolve(delegatesDir, "sessions", "parent.jsonl"));

    mode = detectMode(registry, currentFile);

    // In PR1 we only initialise state; tools and commands come in PR2+
  });

  // Add a command to inspect delegate state (handy for testing PR1)
  pi.registerCommand("delegate-status", {
    description: "Show delegate registry status (debug)",
    handler: async (_args, ctx) => {
      if (!registry) {
        ctx.ui.notify("Registry not loaded yet", "error");
        return;
      }
      const lines: string[] = [
        `Mode: ${mode ?? "none"}`,
        `Parent session: ${registry.parentSessionFile ?? "(none)"}`,
        `Active delegate: ${registry.activeDelegateId ?? "(none)"}`,
        `Delegates: ${Object.keys(registry.delegates).length}`,
        ...Object.values(registry.delegates).map(
          (d) => `  • ${d.id}: ${d.status} (${d.sessionFile})`
        ),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

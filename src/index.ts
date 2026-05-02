import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Registry } from "./registry.js";
import { type DelegateRegistry, type SessionMode } from "./types.js";
import { resolveGitRoot } from "./utils.js";
import { resolve, join } from "node:path";

function getDelegatesDir(cwd: string): string {
  return resolve(cwd, ".pi", "delegates");
}

function sameFile(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/\/+$/, "") === b.replace(/\\+$/, "");
}

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

export default function delegateExtension(pi: ExtensionAPI) {
  let registry: DelegateRegistry | null = null;
  let mode: SessionMode = null;
  let registryManager: Registry | null = null;
  let gitRoot: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;
    const delegatesDir = getDelegatesDir(cwd);
    registryManager = new Registry(delegatesDir);
    gitRoot = await resolveGitRoot(cwd);

    const currentFile = ctx.sessionManager.getSessionFile();
    registry = await registryManager.load(currentFile ?? resolve(delegatesDir, "sessions", "parent.jsonl"));
    mode = detectMode(registry, currentFile);
  });

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

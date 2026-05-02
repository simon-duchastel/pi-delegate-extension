// ============================================================
// Utility helpers for pi-delegate-extension
// ============================================================

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";

/** Check if a process is still alive */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Generate a slug from a task description (for manual use outside Registry). */
export function slugFromTask(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Run a git command and return { stdout, code, ok } */
export function execGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; code: number; ok: boolean }> {
  return new Promise((resolve) => {
    const child = execFile("git", args, { cwd: cwd ?? process.cwd() }, (error, stdout, stderr) => {
      if (error) {
        resolve({ stdout, stderr, code: error.code as number ?? 1, ok: false });
      } else {
        resolve({ stdout, stderr, code: 0, ok: true });
      }
    });
    child.on("error", () => {
      resolve({ stdout: "", stderr: "git not found", code: 1, ok: false });
    });
  });
}

/** Resolve the git root for a given cwd, or null if not in a repo. */
export async function resolveGitRoot(cwd: string): Promise<string | null> {
  try {
    const result = await execGit(["rev-parse", "--show-toplevel"], cwd);
    if (!result.ok) return null;
    const trimmed = result.stdout.trim();
    if (!trimmed) return null;
    return await realpath(trimmed);
  } catch {
    return null;
  }
}

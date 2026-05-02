import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";

export function execGit(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number; ok: boolean }> {
  return new Promise((resolve) => {
    const child = execFile("git", args, { cwd: cwd ?? process.cwd() }, (error, stdout, stderr) => {
      if (error) {
        resolve({ stdout, stderr, code: (error.code as number) ?? 1, ok: false });
      } else {
        resolve({ stdout, stderr, code: 0, ok: true });
      }
    });
    child.on("error", () => {
      resolve({ stdout: "", stderr: "git not found", code: 1, ok: false });
    });
  });
}

export async function resolveGitRoot(cwd: string): Promise<string | null> {
  const result = await execGit(["rev-parse", "--show-toplevel"], cwd);
  if (!result.ok) return null;
  const trimmed = result.stdout.trim();
  if (!trimmed) return null;
  return realpath(trimmed);
}

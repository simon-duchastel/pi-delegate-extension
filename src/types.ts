// ============================================================
// Delegate types — shared across the pi-delegate-extension
// ============================================================

/** Per-delegate status */
export type DelegateStatus = "idle" | "running" | "done" | "failed";

/** Single record in the registry */
export interface DelegateRecord {
  id: string; // slug, e.g. "fix-auth"
  sessionFile: string; // absolute path to delegate JSONL
  cwd: string; // working directory of delegate
  branch?: string; // git branch if created as worktree
  task: string; // original task description
  status: DelegateStatus;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** On-disk registry format */
export interface DelegateRegistry {
  version: 1;
  parentSessionFile: string; // path to the parent session JSONL
  activeDelegateId: string | null; // which delegate is currently focused
  delegates: Record<string, DelegateRecord>;
}

/** Options passed to registry.allocate() */
export interface AllocateOptions {
  id?: string; // explicit slug; auto-generated from task if omitted
  asWorktree?: boolean; // create a git worktree for isolation
}

/** Result of detecting session mode */
export type SessionMode = "parent" | "child" | null;

export type DelegateStatus = "idle" | "running" | "done" | "failed";

export interface DelegateRecord {
  id: string;
  sessionFile: string;
  cwd: string;
  branch?: string;
  task: string;
  status: DelegateStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DelegateRegistry {
  version: 1;
  parentSessionFile: string;
  activeDelegateId: string | null;
  delegates: Record<string, DelegateRecord>;
}

export interface AllocateOptions {
  id?: string;
  asWorktree?: boolean;
}

export type SessionMode = "parent" | "child" | null;

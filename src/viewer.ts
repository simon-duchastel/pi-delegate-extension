// ============================================================
// Delegate conversation viewer — reads JSONL and formats
// ============================================================

import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { DelegateRecord } from "./types.js";

/**
 * Read a delegate session JSONL and return a formatted markdown string.
 */
export async function formatDelegateConversation(record: DelegateRecord): Promise<string> {
  const sm = SessionManager.open(record.sessionFile);
  const entries = sm.getBranch();

  const lines: string[] = [
    `## Delegate: ${record.id}`,
    `**Status:** ${record.status}${record.branch ? ` | **Branch:** ${record.branch}` : ""} | **CWD:** ${record.cwd}`,
    "",
    "### Conversation",
  ];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : extractTextContent(msg.content);
      lines.push(`**user:** ${text}`);
    } else if (msg.role === "assistant") {
      const text = extractTextFromAssistant(msg);
      if (text) {
        lines.push(`**assistant:** ${text}`);
      }
    } else if (msg.role === "toolResult") {
      const text = typeof msg.content === "string" ? msg.content : extractTextContent(msg.content);
      lines.push(`**[${msg.toolName} result]:** ${text}`);
    }
  }

  if (lines.length === 4) {
    lines.push("_No conversation yet._");
  }

  lines.push("");
  return lines.join("\n");
}

function extractTextContent(content: any[]): string {
  return content
    .map((c: any) => {
      if (typeof c === "string") return c;
      if (c?.type === "text") return c.text ?? "";
      return "";
    })
    .join("");
}

function extractTextFromAssistant(msg: any): string {
  if (!msg.content) return "";
  const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
  return parts
    .map((p: any) => {
      if (typeof p === "string") return p;
      if (p?.type === "text") return p.text ?? "";
      if (p?.type === "thinking") return `*(thinking)* ${p.thinking ?? ""}`;
      if (p?.type === "toolCall") return `*(tool: ${p.name})*`;
      return "";
    })
    .join("");
}

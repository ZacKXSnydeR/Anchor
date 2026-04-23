import * as fs from "fs";
import * as path from "path";

import { DaemonClient } from "../ipc/daemon-client";
import { PbDecryptor } from "./pb-decryptor";

export type PbFileMeta = {
  id: string;
  path: string;
  size: number;
  modifiedAt: number;
};

export type RecoveredMessage = {
  role: string;
  content: string;
  timestamp?: number;
};

export type RecoveredConversation = {
  id: string;
  pbPath: string;
  timestamp: number;
  messages: RecoveredMessage[];
  recoveryMethod: string;
  confidence: number;
  recoveredTextBlocks: string[];
  recoveredMessageCount: number;
  daemonData: unknown;
  markdown: string;
};

export class PbFileReader {
  private readonly decryptor = new PbDecryptor();

  constructor(private readonly daemonClient: DaemonClient) {}

  extractTextContent(pbBuffer: Buffer): string[] {
    const decoded = pbBuffer.toString("utf8");
    const blocks: string[] = [];
    let current = "";

    for (const char of decoded) {
      if (isAllowedChar(char)) {
        current += char;
        continue;
      }

      pushBlock(blocks, current);
      current = "";
    }

    pushBlock(blocks, current);

    const seen = new Set<string>();
    const unique: string[] = [];
    for (const block of blocks) {
      if (!seen.has(block)) {
        seen.add(block);
        unique.push(block);
      }
    }

    return unique;
  }

  listPbFiles(antigravityDir: string): PbFileMeta[] {
    const conversationsRoot = path.join(antigravityDir, "conversations");
    if (!fs.existsSync(conversationsRoot)) {
      return [];
    }

    const pbFiles: PbFileMeta[] = [];
    const stack: string[] = [conversationsRoot];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }

        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".pb") {
          continue;
        }

        const stat = fs.statSync(fullPath);
        pbFiles.push({
          id: path.basename(entry.name, ".pb"),
          path: fullPath,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        });
      }
    }

    pbFiles.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return pbFiles;
  }

  async extractConversation(pbPath: string): Promise<RecoveredConversation> {
    const stat = fs.statSync(pbPath);
    const id = path.basename(pbPath, ".pb");
    const decryptResult = await this.decryptor.decrypt(pbPath);

    let messages: RecoveredMessage[] = [];
    let recoveryMethod = decryptResult.method;
    let confidence = decryptResult.confidence;

    if (confidence > 70) {
      messages = extractMessagesFromProtobuf(decryptResult.buffer);
      if (messages.length > 0) {
        recoveryMethod = `${decryptResult.method}+protobuf`;
        confidence = Math.max(confidence, 88);
      }
    }

    if (messages.length === 0) {
      const textBlocks = this.extractTextContent(decryptResult.buffer);
      messages = textBlocks.map((content) => ({
        role: "unknown",
        content,
      }));
      recoveryMethod = `${decryptResult.method}+raw_scan`;
      confidence = Math.min(confidence, 70);
    }

    const daemonData = await this.fetchDaemonRecovery(id);
    const daemonBlocks = extractStringsFromUnknown(daemonData);
    if (daemonBlocks.length > 0) {
      const mergedBlocks = mergeBlocks(messages.map((item) => item.content), daemonBlocks);
      messages = mergedBlocks.map((content, index) => {
        const existing = messages[index];
        return {
          role: existing?.role ?? "unknown",
          content,
          timestamp: existing?.timestamp,
        };
      });
    }

    const recoveredTextBlocks = messages.map((item) => item.content);
    const markdown = toMarkdown(
      id,
      pbPath,
      stat.mtimeMs,
      messages,
      daemonData,
      recoveryMethod,
      confidence,
    );

    return {
      id,
      pbPath,
      timestamp: stat.mtimeMs,
      messages,
      recoveryMethod,
      confidence,
      recoveredTextBlocks,
      recoveredMessageCount: recoveredTextBlocks.length,
      daemonData,
      markdown,
    };
  }

  async recoverConversation(pbPath: string): Promise<RecoveredConversation> {
    return this.extractConversation(pbPath);
  }

  private async fetchDaemonRecovery(conversationId: string): Promise<unknown> {
    try {
      if (!this.daemonClient.isConnected()) {
        await this.daemonClient.connect();
      }

      const response = await this.daemonClient.sendMessage({
        type: "Recover",
        payload: { conversation_id: conversationId },
      });

      if (response.type === "Data") {
        return response.payload;
      }
    } catch {
      // Best-effort daemon enrichment.
    }

    return null;
  }
}

function extractMessagesFromProtobuf(pbBuffer: Buffer): RecoveredMessage[] {
  const collected: RecoveredMessage[] = [];
  walkMessage(pbBuffer, collected, 0);
  return dedupeMessages(collected);
}

function walkMessage(buffer: Buffer, collector: RecoveredMessage[], depth: number): void {
  if (depth > 8) {
    return;
  }

  let cursor = 0;
  let current: Partial<RecoveredMessage> = {};

  while (cursor < buffer.length) {
    const key = readVarint(buffer, cursor);
    if (!key) {
      break;
    }
    cursor = key.next;

    const field = key.value >> 3;
    const wireType = key.value & 0x07;

    if (wireType === 0) {
      const varint = readVarint(buffer, cursor);
      if (!varint) {
        break;
      }
      cursor = varint.next;
      if (field === 3) {
        current.timestamp = varint.value;
      }
      continue;
    }

    if (wireType === 2) {
      const lenInfo = readVarint(buffer, cursor);
      if (!lenInfo) {
        break;
      }
      cursor = lenInfo.next;
      const end = cursor + lenInfo.value;
      if (end > buffer.length || lenInfo.value < 0) {
        break;
      }

      const payload = buffer.subarray(cursor, end);
      cursor = end;

      if (field === 1) {
        const content = decodeUtf8Strict(payload);
        if (content && content.trim().length > 0) {
          if (current.content) {
            pushRecoveredMessage(collector, current);
            current = {};
          }
          current.content = content.trim();
        } else {
          walkMessage(payload, collector, depth + 1);
        }
        continue;
      }

      if (field === 2) {
        const role = decodeUtf8Strict(payload);
        if (role) {
          current.role = normalizeRole(role.trim());
        }
        continue;
      }

      if (field === 3) {
        const tsFromBytes = decodeUtf8Strict(payload);
        if (tsFromBytes && /^\d+$/.test(tsFromBytes.trim())) {
          current.timestamp = Number(tsFromBytes.trim());
        }
      }

      if (looksNested(payload)) {
        walkMessage(payload, collector, depth + 1);
      }
      continue;
    }

    if (wireType === 1) {
      cursor += 8;
      continue;
    }

    if (wireType === 5) {
      cursor += 4;
      continue;
    }

    break;
  }

  pushRecoveredMessage(collector, current);
}

function pushRecoveredMessage(collector: RecoveredMessage[], partial: Partial<RecoveredMessage>): void {
  const content = partial.content?.trim();
  if (!content || content.length === 0) {
    return;
  }

  collector.push({
    role: partial.role ?? "unknown",
    content,
    timestamp: partial.timestamp,
  });
}

function readVarint(buffer: Buffer, start: number): { value: number; next: number } | null {
  let result = 0;
  let shift = 0;
  let cursor = start;

  while (cursor < buffer.length && shift <= 35) {
    const byte = buffer[cursor];
    result |= (byte & 0x7f) << shift;
    cursor += 1;

    if ((byte & 0x80) === 0) {
      return { value: result, next: cursor };
    }

    shift += 7;
  }

  return null;
}

function decodeUtf8Strict(payload: Buffer): string | null {
  const decoded = payload.toString("utf8");
  if (decoded.includes("\uFFFD")) {
    return null;
  }
  return decoded;
}

function looksNested(payload: Buffer): boolean {
  if (payload.length < 2) {
    return false;
  }
  const first = payload[0];
  return first > 0 && first < 0x80;
}

function normalizeRole(role: string): string {
  const lower = role.toLowerCase();
  if (lower.includes("user")) {
    return "user";
  }
  if (lower.includes("assistant") || lower.includes("model") || lower.includes("ai")) {
    return "assistant";
  }
  if (lower.includes("system")) {
    return "system";
  }
  return "unknown";
}

function dedupeMessages(messages: RecoveredMessage[]): RecoveredMessage[] {
  const seen = new Set<string>();
  const unique: RecoveredMessage[] = [];
  for (const message of messages) {
    const key = `${message.role}|${message.timestamp ?? 0}|${message.content}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(message);
    }
  }
  return unique;
}

function isAllowedChar(char: string): boolean {
  if (char === "\n" || char === "\r" || char === "\t") {
    return true;
  }

  const code = char.codePointAt(0);
  if (code === undefined) {
    return false;
  }

  if (code < 32) {
    return false;
  }

  if (code >= 127 && code <= 159) {
    return false;
  }

  if (char === "\uFFFD") {
    return false;
  }

  return true;
}

function pushBlock(blocks: string[], raw: string): void {
  const normalized = raw
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();

  if (normalized.length <= 20) {
    return;
  }

  const printableRatio =
    normalized.length === 0
      ? 0
      : normalized.replace(/[^\p{L}\p{N}\p{P}\p{S}\p{Z}]/gu, "").length / normalized.length;
  if (printableRatio < 0.8) {
    return;
  }

  blocks.push(normalized);
}

function mergeBlocks(primary: string[], fallback: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const block of [...primary, ...fallback]) {
    const key = block.trim();
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(key);
  }

  return merged;
}

function extractStringsFromUnknown(value: unknown): string[] {
  const results: string[] = [];
  walk(value, results);

  const filtered = results
    .map((item) => item.trim())
    .filter((item) => item.length > 20)
    .slice(0, 300);

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of filtered) {
    if (!seen.has(item)) {
      seen.add(item);
      unique.push(item);
    }
  }

  return unique;
}

function walk(value: unknown, collector: string[]): void {
  if (typeof value === "string") {
    collector.push(value);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => {
      walk(item, collector);
    });
    return;
  }

  if (typeof value === "object" && value !== null) {
    Object.values(value as Record<string, unknown>).forEach((item) => {
      walk(item, collector);
    });
  }
}

function toMarkdown(
  id: string,
  pbPath: string,
  timestamp: number,
  messages: RecoveredMessage[],
  daemonData: unknown,
  recoveryMethod: string,
  confidence: number,
): string {
  const lines: string[] = [];
  lines.push(`# Recovered Conversation ${id}`);
  lines.push("");
  lines.push(`- Source: ${pbPath}`);
  lines.push(`- Recovered At: ${new Date().toISOString()}`);
  lines.push(`- Original Modified At: ${new Date(timestamp).toISOString()}`);
  lines.push(`- Message Blocks: ${messages.length}`);
  lines.push(`- Recovery Method: ${recoveryMethod}`);
  lines.push(`- Confidence: ${confidence}%`);
  lines.push("");
  lines.push("## Recovered Messages");
  lines.push("");

  if (messages.length === 0) {
    lines.push("No textual messages could be recovered.");
  }

  messages.forEach((message, index) => {
    lines.push(`### Message ${index + 1}`);
    lines.push("");
    lines.push(`- Role: ${message.role}`);
    if (message.timestamp) {
      lines.push(`- Timestamp: ${new Date(message.timestamp).toISOString()}`);
    }
    lines.push("");
    lines.push(message.content);
    lines.push("");
  });

  if (daemonData !== null && daemonData !== undefined) {
    lines.push("## Daemon Cross-Reference");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(daemonData, null, 2));
    lines.push("```");
  }

  return lines.join("\n");
}

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";

import { PbDecryptor } from "./pb-decryptor";

const TRAJECTORY_KEY = "antigravityUnifiedStateSync.trajectorySummaries";

type PbFileMeta = {
  id: string;
  path: string;
  size: number;
  modifiedAt: number;
};

type IndexRow = {
  key: string;
  value: string;
};

type ReadIndexResult = {
  key: string;
  summaries: TrajectorySummary[];
};

type ProtobufMessage = {
  role: string;
  content: string;
  timestamp?: number;
};

export type TrajectorySummary = {
  id: string;
  title: string;
  workspacePath: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
};

export type RepairResult = {
  success: boolean;
  restoredCount: number;
  totalConversations: number;
  backupPath: string;
};

/**
 * Repairs Antigravity's sidebar index by rebuilding missing trajectory summaries from .pb files.
 */
export class StateRepair {
  private readonly decryptor = new PbDecryptor();

  /**
   * Returns the most likely state.vscdb path for this platform.
   */
  getStateDbPath(): string {
    const home = os.homedir();
    const appData = process.env.APPDATA ?? "";

    const primary = (() => {
      if (process.platform === "win32") {
        return path.join(appData || home, "antigravity", "state.vscdb");
      }
      if (process.platform === "darwin") {
        return path.join(home, "Library", "Application Support", "antigravity", "state.vscdb");
      }
      return path.join(home, ".config", "antigravity", "state.vscdb");
    })();

    const candidates = [
      primary,
      path.join(home, ".gemini", "antigravity", "state.vscdb"),
      path.join(home, ".antigravity", "state.vscdb"),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return primary;
  }

  /**
   * Reads and decodes the current trajectory summary index from state.vscdb.
   */
  readCurrentIndex(dbPath = this.getStateDbPath()): TrajectorySummary[] {
    if (!fs.existsSync(dbPath)) {
      return [];
    }

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return this.readCurrentIndexFromDb(db).summaries;
    } finally {
      db.close();
    }
  }

  /**
   * Scans known Antigravity conversation roots and returns all .pb files sorted by recency.
   */
  getPbFilesOnDisk(): PbFileMeta[] {
    const pbFiles: PbFileMeta[] = [];
    const roots = this.getConversationRoots();

    for (const root of roots) {
      if (!fs.existsSync(root)) {
        continue;
      }

      const stack: string[] = [root];
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
    }

    pbFiles.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return pbFiles;
  }

  /**
   * Finds conversations present on disk but missing from the current sidebar index.
   */
  findMissingConversations(pbFiles: PbFileMeta[], current: TrajectorySummary[]): PbFileMeta[] {
    const indexedIds = new Set(current.map((item) => item.id));
    return pbFiles.filter((item) => !indexedIds.has(item.id));
  }

  /**
   * Builds a trajectory summary from a single .pb file.
   */
  async buildSummaryFromPb(pbPath: string): Promise<TrajectorySummary | null> {
    const stat = await fs.promises.stat(pbPath);
    const id = path.basename(pbPath, ".pb");
    const decryptResult = await this.decryptor.decrypt(pbPath);

    const messages = extractMessagesFromProtobuf(decryptResult.buffer);
    const firstUser = messages.find((message) => message.role === "user");
    const firstAny = messages.find((message) => message.content.trim().length > 0);
    const titleSource = firstUser?.content ?? firstAny?.content ?? `Recovered ${id}`;
    const title = compactTitle(titleSource, 96);

    const timestamps = messages
      .map((message) => message.timestamp)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const createdAt = timestamps.length > 0 ? Math.min(...timestamps) : stat.mtimeMs;
    const updatedAt = timestamps.length > 0 ? Math.max(...timestamps) : stat.mtimeMs;

    const workspaceGuess = this.guessWorkspacePath(pbPath);
    const messageCount = Math.max(messages.length, estimateMessageCountFromText(decryptResult.buffer));

    return {
      id,
      title,
      workspacePath: workspaceGuess,
      createdAt,
      updatedAt,
      messageCount,
    };
  }

  /**
   * Encodes trajectory summaries into base64 protobuf payload.
   */
  encodeIndex(summaries: TrajectorySummary[]): string {
    const encodedItems = summaries
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((summary) => encodeLengthDelimited(1, encodeSummary(summary)));

    return Buffer.concat(encodedItems).toString("base64");
  }

  /**
   * Writes repaired index entries back to state.vscdb using WAL and verification.
   */
  async repairDatabase(newSummaries: TrajectorySummary[]): Promise<RepairResult> {
    const dbPath = this.getStateDbPath();
    if (!fs.existsSync(dbPath)) {
      return {
        success: true,
        restoredCount: 0,
        totalConversations: 0,
        backupPath: "",
      };
    }

    const backupPath = `${dbPath}.anchor-backup-${Date.now()}.bak`;
    await fs.promises.copyFile(dbPath, backupPath);

    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: false, fileMustExist: true });
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");

      const current = this.readCurrentIndexFromDb(db);
      const merged = mergeSummaries(current.summaries, newSummaries);
      const restoredCount = Math.max(0, merged.length - current.summaries.length);

      if (restoredCount === 0) {
        db.close();
        return {
          success: true,
          restoredCount: 0,
          totalConversations: merged.length,
          backupPath,
        };
      }

      const encodedValue = this.encodeIndex(merged);

      const writableDb = db;
      const writeTx = writableDb.transaction(() => {
        writableDb
          .prepare(
          `
          INSERT INTO ItemTable (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `,
          )
          .run(current.key, encodedValue);
      });
      writeTx();

      const verify = this.readCurrentIndexFromDb(db);
      const missingAfterWrite = merged.some(
        (expected) => !verify.summaries.some((actual) => actual.id === expected.id),
      );
      if (missingAfterWrite) {
        throw new Error("State index verify failed after write");
      }

      db.close();
      return {
        success: true,
        restoredCount,
        totalConversations: verify.summaries.length,
        backupPath,
      };
    } catch {
      if (db) {
        db.close();
      }

      await fs.promises.copyFile(backupPath, dbPath);
      return {
        success: false,
        restoredCount: 0,
        totalConversations: 0,
        backupPath,
      };
    }
  }

  /**
   * Runs the complete repair pipeline: read index, scan .pb, diff, rebuild, write, verify.
   */
  async runFullRepair(): Promise<RepairResult> {
    const currentIndex = this.readCurrentIndex();
    const pbFiles = this.getPbFilesOnDisk();
    const missing = this.findMissingConversations(pbFiles, currentIndex);

    const built: TrajectorySummary[] = [];
    for (const item of missing) {
      const summary = await this.buildSummaryFromPb(item.path);
      if (summary) {
        built.push(summary);
      }
    }

    return this.repairDatabase(built);
  }

  /**
   * Reads index rows directly from an already-open sqlite connection.
   */
  private readCurrentIndexFromDb(db: Database.Database): ReadIndexResult {
    const exact = db.prepare("SELECT key, value FROM ItemTable WHERE key = ? LIMIT 1").get(TRAJECTORY_KEY);
    const fallback = db
      .prepare("SELECT key, value FROM ItemTable WHERE key LIKE ? ORDER BY key LIMIT 1")
      .get("%trajectorySummaries%");
    const rowUnknown = exact ?? fallback;

    if (!isRecord(rowUnknown) || typeof rowUnknown.key !== "string" || typeof rowUnknown.value !== "string") {
      return { key: TRAJECTORY_KEY, summaries: [] };
    }

    const row = rowUnknown as IndexRow;
    if (row.value.trim().length === 0) {
      return { key: row.key, summaries: [] };
    }

    try {
      const buffer = Buffer.from(row.value, "base64");
      const summaries = parseTrajectorySummaries(buffer);
      return { key: row.key, summaries };
    } catch {
      return { key: row.key, summaries: [] };
    }
  }

  /**
   * Returns likely conversation roots used by Antigravity in different releases.
   */
  private getConversationRoots(): string[] {
    const home = os.homedir();
    return [
      path.join(home, ".gemini", "antigravity", "conversations"),
      path.join(home, ".antigravity", "conversations"),
    ];
  }

  /**
   * Guesses workspace path for recovered conversation metadata.
   */
  private guessWorkspacePath(pbPath: string): string {
    const cwd = process.cwd();
    if (cwd && cwd.length > 1) {
      return cwd;
    }
    return path.dirname(pbPath);
  }
}

/**
 * Parses summary protobuf entries from a base64-decoded trajectorySummaries payload.
 */
function parseTrajectorySummaries(buffer: Buffer): TrajectorySummary[] {
  const summaries: TrajectorySummary[] = [];
  let cursor = 0;
  const now = Date.now();

  while (cursor < buffer.length) {
    const keyInfo = readVarint(buffer, cursor);
    if (!keyInfo) {
      break;
    }
    cursor = keyInfo.next;

    const field = keyInfo.value >> 3;
    const wireType = keyInfo.value & 0x07;
    if (wireType !== 2) {
      const skipped = skipField(buffer, cursor, wireType);
      if (skipped === null) {
        break;
      }
      cursor = skipped;
      continue;
    }

    const lenInfo = readVarint(buffer, cursor);
    if (!lenInfo) {
      break;
    }
    cursor = lenInfo.next;
    const end = cursor + lenInfo.value;
    if (lenInfo.value < 0 || end > buffer.length) {
      break;
    }

    const payload = buffer.subarray(cursor, end);
    cursor = end;

    if (field !== 1) {
      continue;
    }

    const parsed = decodeSummary(payload, now);
    if (parsed) {
      summaries.push(parsed);
    }
  }

  return dedupeSummaryList(summaries);
}

/**
 * Decodes one trajectory summary protobuf message.
 */
function decodeSummary(payload: Buffer, fallbackTs: number): TrajectorySummary | null {
  let cursor = 0;
  let id = "";
  let title = "";
  let workspacePath = "";
  let createdAt = 0;
  let updatedAt = 0;
  let messageCount = 0;

  while (cursor < payload.length) {
    const keyInfo = readVarint(payload, cursor);
    if (!keyInfo) {
      break;
    }
    cursor = keyInfo.next;

    const field = keyInfo.value >> 3;
    const wireType = keyInfo.value & 0x07;

    if (wireType === 0) {
      const intInfo = readVarint(payload, cursor);
      if (!intInfo) {
        break;
      }
      cursor = intInfo.next;
      if (field === 4) {
        createdAt = intInfo.value;
      } else if (field === 5) {
        updatedAt = intInfo.value;
      } else if (field === 6) {
        messageCount = intInfo.value;
      }
      continue;
    }

    if (wireType === 2) {
      const lenInfo = readVarint(payload, cursor);
      if (!lenInfo) {
        break;
      }
      cursor = lenInfo.next;
      const end = cursor + lenInfo.value;
      if (lenInfo.value < 0 || end > payload.length) {
        break;
      }

      const fieldData = payload.subarray(cursor, end);
      cursor = end;
      const text = decodeUtf8Strict(fieldData);

      if (field === 1 && text) {
        id = text.trim();
      } else if (field === 2 && text) {
        title = text.trim();
      } else if (field === 3 && text) {
        workspacePath = text.trim();
      }
      continue;
    }

    const skipped = skipField(payload, cursor, wireType);
    if (skipped === null) {
      break;
    }
    cursor = skipped;
  }

  if (!id) {
    return null;
  }

  return {
    id,
    title: title || `Recovered ${id}`,
    workspacePath: workspacePath || "",
    createdAt: createdAt > 0 ? createdAt : fallbackTs,
    updatedAt: updatedAt > 0 ? updatedAt : fallbackTs,
    messageCount: Math.max(0, messageCount),
  };
}

/**
 * Encodes one trajectory summary to protobuf binary.
 */
function encodeSummary(summary: TrajectorySummary): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(encodeLengthDelimited(1, Buffer.from(summary.id, "utf8")));
  chunks.push(encodeLengthDelimited(2, Buffer.from(summary.title, "utf8")));
  chunks.push(encodeLengthDelimited(3, Buffer.from(summary.workspacePath, "utf8")));
  chunks.push(encodeVarintField(4, safeInt(summary.createdAt)));
  chunks.push(encodeVarintField(5, safeInt(summary.updatedAt)));
  chunks.push(encodeVarintField(6, safeInt(summary.messageCount)));
  return Buffer.concat(chunks);
}

/**
 * Protobuf varint reader.
 */
function readVarint(buffer: Buffer, start: number): { value: number; next: number } | null {
  let result = 0;
  let shift = 0;
  let cursor = start;

  while (cursor < buffer.length && shift <= 35) {
    const byte = buffer[cursor];
    result |= (byte & 0x7f) << shift;
    cursor += 1;

    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, next: cursor };
    }

    shift += 7;
  }

  return null;
}

/**
 * Protobuf varint encoder.
 */
function encodeVarint(value: number): Buffer {
  let remaining = safeInt(value);
  const bytes: number[] = [];

  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

/**
 * Encodes a protobuf field with wire type 0.
 */
function encodeVarintField(field: number, value: number): Buffer {
  return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(value)]);
}

/**
 * Encodes a protobuf field with wire type 2.
 */
function encodeLengthDelimited(field: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(payload.length), payload]);
}

/**
 * Skips a protobuf field when we do not need to parse it.
 */
function skipField(buffer: Buffer, cursor: number, wireType: number): number | null {
  if (wireType === 0) {
    const info = readVarint(buffer, cursor);
    return info?.next ?? null;
  }

  if (wireType === 1) {
    return cursor + 8 <= buffer.length ? cursor + 8 : null;
  }

  if (wireType === 2) {
    const lenInfo = readVarint(buffer, cursor);
    if (!lenInfo) {
      return null;
    }
    const end = lenInfo.next + lenInfo.value;
    return end <= buffer.length ? end : null;
  }

  if (wireType === 5) {
    return cursor + 4 <= buffer.length ? cursor + 4 : null;
  }

  return null;
}

/**
 * Decodes UTF-8 and rejects replacement characters.
 */
function decodeUtf8Strict(input: Buffer): string | null {
  const decoded = input.toString("utf8");
  if (decoded.includes("\uFFFD")) {
    return null;
  }
  return decoded;
}

/**
 * Merges new summaries into current list without overriding existing entries.
 */
function mergeSummaries(current: TrajectorySummary[], incoming: TrajectorySummary[]): TrajectorySummary[] {
  const merged = new Map<string, TrajectorySummary>();
  for (const summary of current) {
    merged.set(summary.id, summary);
  }

  for (const summary of incoming) {
    if (!merged.has(summary.id)) {
      merged.set(summary.id, summary);
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Removes duplicate summaries by id while keeping the newest updatedAt.
 */
function dedupeSummaryList(summaries: TrajectorySummary[]): TrajectorySummary[] {
  const map = new Map<string, TrajectorySummary>();
  for (const summary of summaries) {
    const existing = map.get(summary.id);
    if (!existing || summary.updatedAt > existing.updatedAt) {
      map.set(summary.id, summary);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Extracts protobuf messages by field-1 content / field-2 role / field-3 timestamp.
 */
function extractMessagesFromProtobuf(buffer: Buffer): ProtobufMessage[] {
  const collected: ProtobufMessage[] = [];
  walkMessage(buffer, collected, 0);
  return dedupeMessages(collected);
}

/**
 * Recursive protobuf walker for message extraction.
 */
function walkMessage(buffer: Buffer, collector: ProtobufMessage[], depth: number): void {
  if (depth > 8) {
    return;
  }

  let cursor = 0;
  let current: Partial<ProtobufMessage> = {};

  while (cursor < buffer.length) {
    const keyInfo = readVarint(buffer, cursor);
    if (!keyInfo) {
      break;
    }
    cursor = keyInfo.next;

    const field = keyInfo.value >> 3;
    const wireType = keyInfo.value & 0x07;

    if (wireType === 0) {
      const intInfo = readVarint(buffer, cursor);
      if (!intInfo) {
        break;
      }
      cursor = intInfo.next;
      if (field === 3) {
        current.timestamp = intInfo.value;
      }
      continue;
    }

    if (wireType !== 2) {
      const skipped = skipField(buffer, cursor, wireType);
      if (skipped === null) {
        break;
      }
      cursor = skipped;
      continue;
    }

    const lenInfo = readVarint(buffer, cursor);
    if (!lenInfo) {
      break;
    }
    cursor = lenInfo.next;
    const end = cursor + lenInfo.value;
    if (lenInfo.value < 0 || end > buffer.length) {
      break;
    }

    const payload = buffer.subarray(cursor, end);
    cursor = end;

    if (field === 1) {
      const content = decodeUtf8Strict(payload);
      if (content && content.trim().length > 0) {
        if (current.content) {
          pushMessage(collector, current);
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
        current.role = normalizeRole(role);
      }
      continue;
    }

    if (field === 3) {
      const maybeTs = decodeUtf8Strict(payload);
      if (maybeTs && /^\d+$/.test(maybeTs.trim())) {
        current.timestamp = Number(maybeTs.trim());
      }
    }

    walkMessage(payload, collector, depth + 1);
  }

  pushMessage(collector, current);
}

/**
 * Pushes a message candidate when it contains usable content.
 */
function pushMessage(collector: ProtobufMessage[], partial: Partial<ProtobufMessage>): void {
  if (!partial.content || partial.content.trim().length === 0) {
    return;
  }

  collector.push({
    role: partial.role ?? "unknown",
    content: partial.content.trim(),
    timestamp: partial.timestamp,
  });
}

/**
 * Deduplicates protobuf message candidates.
 */
function dedupeMessages(messages: ProtobufMessage[]): ProtobufMessage[] {
  const seen = new Set<string>();
  const unique: ProtobufMessage[] = [];

  for (const message of messages) {
    const key = `${message.role}|${message.timestamp ?? 0}|${message.content}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(message);
  }

  return unique;
}

/**
 * Estimates message count from fallback text extraction when protobuf parse is sparse.
 */
function estimateMessageCountFromText(buffer: Buffer): number {
  const text = buffer.toString("utf8");
  const chunks = text
    .split(/[\u0000-\u001F]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 24);
  return new Set(chunks).size;
}

/**
 * Produces a short single-line title.
 */
function compactTitle(value: string, maxLen: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(0, maxLen - 3))}...`;
}

/**
 * Normalizes role labels from recovered protobuf values.
 */
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

/**
 * Checks object-like runtime values without using any.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Ensures numbers are valid uint32-compatible values for protobuf varints.
 */
function safeInt(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.floor(value), 0x7fffffff);
}

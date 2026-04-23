import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";

export type DecryptResult = {
  success: boolean;
  buffer: Buffer;
  method: string;
  confidence: number;
};

/**
 * Cross-platform protobuf decryptor with safe fallbacks.
 * It never throws raw content and always returns a result object.
 */
export class PbDecryptor {
  async decrypt(pbPath: string): Promise<DecryptResult> {
    let source: Buffer;
    try {
      source = await fs.promises.readFile(pbPath);
    } catch {
      return { success: false, buffer: Buffer.alloc(0), method: "read_failed", confidence: 0 };
    }

    if (process.platform === "linux") {
      const linuxResult = this.decryptLinux(source);
      if (linuxResult.success) {
        return linuxResult;
      }
    }

    if (process.platform === "win32") {
      const windowsResult = await this.decryptWindows(source);
      if (windowsResult.success) {
        return windowsResult;
      }
    }

    if (process.platform === "darwin") {
      const macResult = this.decryptMac(source);
      if (macResult.success) {
        return macResult;
      }
    }

    return this.rawFallback(source);
  }

  private decryptLinux(source: Buffer): DecryptResult {
    if (looksProtobufLike(source)) {
      return {
        success: true,
        buffer: source,
        method: "basic_text",
        confidence: 80,
      };
    }

    const decrypted = tryLinuxAesGcm(source);
    if (decrypted) {
      return {
        success: true,
        buffer: decrypted,
        method: "linux_aes256gcm",
        confidence: 78,
      };
    }

    return { success: false, buffer: source, method: "linux_unknown", confidence: 20 };
  }

  private async decryptWindows(source: Buffer): Promise<DecryptResult> {
    const keytarResult = await tryWindowsKeytar(source);
    if (keytarResult) {
      return {
        success: true,
        buffer: keytarResult,
        method: "windows_keytar",
        confidence: 88,
      };
    }

    const dpapiResult = await tryWindowsDpapi(source);
    if (dpapiResult) {
      return {
        success: true,
        buffer: dpapiResult,
        method: "windows_dpapi",
        confidence: 92,
      };
    }

    return { success: false, buffer: source, method: "windows_unknown", confidence: 20 };
  }

  private decryptMac(source: Buffer): DecryptResult {
    try {
      const electronModule = tryRequire("electron");
      if (!isRecord(electronModule)) {
        return { success: false, buffer: source, method: "mac_safe_storage_unavailable", confidence: 20 };
      }

      const safeStorageUnknown = electronModule.safeStorage;
      if (!isRecord(safeStorageUnknown)) {
        return { success: false, buffer: source, method: "mac_safe_storage_unavailable", confidence: 20 };
      }

      const isAvailableFn = safeStorageUnknown.isEncryptionAvailable;
      const decryptStringFn = safeStorageUnknown.decryptString;
      if (typeof isAvailableFn !== "function" || typeof decryptStringFn !== "function") {
        return { success: false, buffer: source, method: "mac_safe_storage_unavailable", confidence: 20 };
      }

      const available = (isAvailableFn as () => boolean)();
      if (!available) {
        return { success: false, buffer: source, method: "mac_safe_storage_disabled", confidence: 25 };
      }

      const decryptedText = (decryptStringFn as (value: Buffer) => string)(source);
      return {
        success: true,
        buffer: Buffer.from(decryptedText, "utf8"),
        method: "mac_safe_storage",
        confidence: 94,
      };
    } catch {
      return { success: false, buffer: source, method: "mac_safe_storage_failed", confidence: 20 };
    }
  }

  private rawFallback(source: Buffer): DecryptResult {
    return {
      success: false,
      buffer: source,
      method: "raw_binary_scan",
      confidence: 35,
    };
  }
}

function looksProtobufLike(buffer: Buffer): boolean {
  if (buffer.length < 4) {
    return false;
  }

  let tagHits = 0;
  const limit = Math.min(buffer.length, 4096);
  for (let idx = 0; idx < limit; idx += 1) {
    if (buffer[idx] === 0x0a || buffer[idx] === 0x12 || buffer[idx] === 0x1a) {
      tagHits += 1;
    }
  }

  return tagHits >= 2;
}

function tryLinuxAesGcm(source: Buffer): Buffer | null {
  if (source.length < 16 + 12 + 16 + 1) {
    return null;
  }

  try {
    const salt = source.subarray(0, 16);
    const iv = source.subarray(16, 28);
    const authTag = source.subarray(source.length - 16);
    const encrypted = source.subarray(28, source.length - 16);
    const key = crypto.createHash("sha256").update(Buffer.concat([Buffer.from("antigravity"), salt])).digest();

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return plain;
  } catch {
    return null;
  }
}

async function tryWindowsKeytar(source: Buffer): Promise<Buffer | null> {
  try {
    const keytarModule = tryRequire("keytar");
    if (!isRecord(keytarModule) || typeof keytarModule.getPassword !== "function") {
      return null;
    }

    const password = await (keytarModule.getPassword as (service: string, account: string) => Promise<string | null>)(
      "antigravity",
      "safeStorage",
    );
    if (!password) {
      return null;
    }

    const salt = source.subarray(0, Math.min(source.length, 16));
    const key = crypto
      .createHash("sha256")
      .update(Buffer.concat([Buffer.from(password, "utf8"), salt]))
      .digest();

    if (source.length < 16 + 12 + 16 + 1) {
      return null;
    }

    const iv = source.subarray(16, 28);
    const authTag = source.subarray(source.length - 16);
    const encrypted = source.subarray(28, source.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    return null;
  }
}

async function tryWindowsDpapi(source: Buffer): Promise<Buffer | null> {
  const inputBase64 = source.toString("base64");
  const script = [
    `$input = [Convert]::FromBase64String('${inputBase64}')`,
    "$out = [System.Security.Cryptography.ProtectedData]::Unprotect($input, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($out)",
  ].join(";");

  return new Promise<Buffer | null>((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 2000, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }

        const cleaned = stdout.trim();
        if (!cleaned) {
          resolve(null);
          return;
        }

        try {
          resolve(Buffer.from(cleaned, "base64"));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function tryRequire(moduleId: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(moduleId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

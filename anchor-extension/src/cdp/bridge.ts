import { ChildProcess, execFile, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function resolveDaemonPath(
  extensionPath: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  const binary = resolveDaemonBinaryName(platform, arch);
  return path.join(extensionPath, "bin", binary);
}

export function resolveDaemonBinaryName(platform: NodeJS.Platform, arch: string): string {
  if (platform === "linux" && arch === "x64") {
    return "anchor-core-linux-x64";
  }

  if (platform === "darwin" && arch === "x64") {
    return "anchor-core-darwin-x64";
  }

  if (platform === "darwin" && arch === "arm64") {
    return "anchor-core-darwin-arm64";
  }

  if (platform === "win32" && arch === "x64") {
    return "anchor-core-win32-x64.exe";
  }

  throw new Error(`Unsupported platform/architecture: ${platform}/${arch}`);
}

export function startDaemonProcess(daemonPath: string): ChildProcess {
  const daemonProcess = spawn(daemonPath, [], {
    detached: false,
    windowsHide: true,
    stdio: "ignore",
  });

  daemonProcess.unref();
  return daemonProcess;
}

export async function ensureAutostartRegistered(daemonPath: string): Promise<void> {
  if (process.platform === "linux") {
    await ensureLinuxAutostart(daemonPath);
    return;
  }

  if (process.platform === "darwin") {
    await ensureMacAutostart(daemonPath);
    return;
  }

  if (process.platform === "win32") {
    await ensureWindowsAutostart(daemonPath);
  }
}

export function daemonBinaryExists(daemonPath: string): boolean {
  return fs.existsSync(daemonPath);
}

async function ensureLinuxAutostart(daemonPath: string): Promise<void> {
  const serviceDir = path.join(os.homedir(), ".config", "systemd", "user");
  const servicePath = path.join(serviceDir, "anchor.service");

  if (fs.existsSync(servicePath)) {
    return;
  }

  await fs.promises.mkdir(serviceDir, { recursive: true });

  const content = [
    "[Unit]",
    "Description=Anchor Core Daemon",
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${daemonPath}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

  await fs.promises.writeFile(servicePath, content, "utf8");
}

async function ensureMacAutostart(daemonPath: string): Promise<void> {
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, "com.anchor.core.plist");

  if (fs.existsSync(plistPath)) {
    return;
  }

  await fs.promises.mkdir(launchAgentsDir, { recursive: true });

  const escapedPath = escapeXml(daemonPath);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.anchor.core</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapedPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;

  await fs.promises.writeFile(plistPath, plist, "utf8");
}

async function ensureWindowsAutostart(daemonPath: string): Promise<void> {
  const taskName = "AnchorCore";
  const escapedDaemonPath = daemonPath.replace(/'/g, "''");
  const script = [
    `$task = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue`,
    "if (-not $task) {",
    `  $action = New-ScheduledTaskAction -Execute '${escapedDaemonPath}'`,
    "  $trigger = New-ScheduledTaskTrigger -AtLogOn",
    "  Register-ScheduledTask -TaskName 'AnchorCore' -Action $action -Trigger $trigger -Description 'Anchor Core Daemon' -User $env:USERNAME | Out-Null",
    "}",
  ].join(";");

  await execFilePromise("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
}

function execFilePromise(file: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(file, args, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

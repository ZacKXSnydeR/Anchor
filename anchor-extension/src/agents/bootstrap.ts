import * as fs from "fs";
import * as path from "path";

export type AgentBootstrapResult = {
  changed: boolean;
  touchedPaths: string[];
};

const AGENTS_SECTION = [
  "# Anchor Safety Rules",
  "",
  "## File Operations",
  "- use anchor_write_file",
  "- use anchor_edit_file",
  "- use anchor_read_file",
  "",
  "## Why",
  "Anchor provides WAL protection.",
  "",
  "## Tools",
  "- anchor_read_file",
  "- anchor_write_file",
  "- anchor_edit_file",
  "",
].join("\n");

const SKILL_CONTENT = [
  "# Anchor Safe Edit Skill",
  "",
  "Use Anchor WAL tools for file operations when available.",
  "",
  "## Rules",
  "- Always prefer `anchor_read_file`, `anchor_edit_file`, `anchor_write_file`.",
  "- Prefer `anchor_edit_file` for partial changes.",
  "- Keep edits in chunks smaller than 100 lines when practical.",
  "- Always set a clear `operation_hint` for write/edit calls.",
  "- If an Anchor tool call fails, retry once, then fallback safely.",
  "",
  "## Safety",
  "- Do not bypass Anchor tools for normal file edits.",
  "- Do not log private conversation content.",
  "- Keep writes local; do not make cloud calls.",
  "",
].join("\n");

const CHECKPOINT_WORKFLOW = [
  "# /anchor-checkpoint",
  "",
  "1. Save all pending files.",
  "2. Flush WAL through Anchor daemon.",
  "3. Confirm checkpoint status to user.",
  "",
].join("\n");

const RECOVER_WORKFLOW = [
  "# /anchor-recover",
  "",
  "1. Run state database repair.",
  "2. Restore incomplete WAL edits.",
  "3. List recovered items and confidence summary.",
  "",
].join("\n");

/**
 * Installs AGENTS.md additions, Anchor skill, and workflow files without overriding user content.
 */
export async function ensureAgentSkillSystem(workspacePath: string): Promise<AgentBootstrapResult> {
  const touchedPaths: string[] = [];

  const agentsMdPath = path.join(workspacePath, "AGENTS.md");
  const changedAgents = await appendAgentsSection(agentsMdPath);
  if (changedAgents) {
    touchedPaths.push(agentsMdPath);
  }

  const skillDir = path.join(workspacePath, ".agents", "skills", "anchor-safe-edit");
  const skillPath = path.join(skillDir, "SKILL.md");
  const changedSkill = await ensureFileIfMissing(skillPath, SKILL_CONTENT);
  if (changedSkill) {
    touchedPaths.push(skillPath);
  }

  const workflowDir = path.join(workspacePath, ".agents", "workflows");
  const checkpointPath = path.join(workflowDir, "anchor-checkpoint.md");
  const recoverPath = path.join(workflowDir, "anchor-recover.md");
  const changedCheckpoint = await ensureFileIfMissing(checkpointPath, CHECKPOINT_WORKFLOW);
  const changedRecover = await ensureFileIfMissing(recoverPath, RECOVER_WORKFLOW);
  if (changedCheckpoint) {
    touchedPaths.push(checkpointPath);
  }
  if (changedRecover) {
    touchedPaths.push(recoverPath);
  }

  return {
    changed: touchedPaths.length > 0,
    touchedPaths,
  };
}

/**
 * Adds Anchor rules to AGENTS.md or creates the file if needed.
 */
async function appendAgentsSection(filePath: string): Promise<boolean> {
  if (!fs.existsSync(filePath)) {
    await fs.promises.writeFile(filePath, `${AGENTS_SECTION}\n`, "utf8");
    return true;
  }

  const existing = await fs.promises.readFile(filePath, "utf8");
  if (existing.includes("# Anchor Safety Rules")) {
    return false;
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  await fs.promises.writeFile(filePath, `${existing}${separator}${AGENTS_SECTION}\n`, "utf8");
  return true;
}

/**
 * Writes a file only when it does not already exist.
 */
async function ensureFileIfMissing(filePath: string, content: string): Promise<boolean> {
  if (fs.existsSync(filePath)) {
    return false;
  }

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${content}\n`, "utf8");
  return true;
}

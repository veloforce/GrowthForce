import fs from "node:fs";
import path from "node:path";
import type { LocalAttachment, PromptSkillReference, SkillListItem } from "../shared/types";

export function resolveAutomationToolSkills(value: unknown, available: SkillListItem[]): PromptSkillReference[] {
  const names = automationToolStringArray(value, "selectedSkills");
  return names.map((name) => {
    const skill = available.find((item) => item.name === name);
    if (!skill || !skill.enabled || skill.status !== "enabled") {
      throw new Error(`自动化任务 Skill 不可用: ${name}`);
    }
    return { name: skill.name, agent: skill.agent, description: skill.description };
  });
}

export function resolveAutomationToolAttachments(value: unknown): LocalAttachment[] {
  const attachmentPaths = automationToolStringArray(value, "attachmentPaths");
  const attachments = attachmentPaths.map((attachmentPath) => {
    if (!path.isAbsolute(attachmentPath)) throw new Error(`自动化任务附件必须使用绝对路径: ${attachmentPath}`);
    return { name: path.basename(attachmentPath), path: path.normalize(attachmentPath) };
  });
  validateAutomationAttachments(attachments);
  return attachments;
}

export function validateAutomationAttachments(attachments: LocalAttachment[]): void {
  for (const attachment of attachments) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(attachment.path);
    } catch {
      throw new Error(`自动化任务文件不存在: ${attachment.path}`);
    }
    if (!stat.isFile()) throw new Error(`自动化任务附件不是普通文件: ${attachment.path}`);
  }
}

export function validateAutomationSelectedSkills(selectedSkills: PromptSkillReference[], available: SkillListItem[]): void {
  for (const selected of selectedSkills) {
    const skill = available.find((item) => item.name === selected.name && (!selected.agent || item.agent === selected.agent));
    if (!skill || !skill.enabled || skill.status !== "enabled") {
      throw new Error(`自动化任务 Skill 不可用: ${selected.name}`);
    }
  }
}

function automationToolStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`);
  const normalized = value.map((item) => typeof item === "string" ? item.trim() : "");
  if (normalized.some((item) => !item)) throw new Error(`${field} 必须是非空字符串数组`);
  return Array.from(new Set(normalized));
}

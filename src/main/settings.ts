import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import type { AgentStudioSettings, ChatPermissionMode, ThemeMode } from "../shared/types";
import { expandHome } from "./paths";

const VALID_PERMISSION_MODES = new Set<ChatPermissionMode>(["default", "acceptEdits", "bypassPermissions", "auto"]);
const VALID_THEME_MODES = new Set<ThemeMode>(["system", "light", "dark"]);
const MAX_RECENT_WORKSPACE_DIRECTORIES = 5;

export const defaultSettings: AgentStudioSettings = {
  ui: {
    themeMode: "system"
  },
  chat: {
    permissionMode: "auto"
  },
  connector: {
    xhs: {
      selected_account: ""
    },
    wechat: {
      selected_account: ""
    }
  },
  workspace: {
    recentDirectories: []
  },
  skills: {
    installed: {},
    disabled: []
  }
};

export function readSettings(settingsPath: string): AgentStudioSettings {
  const parsed = readRawSettings(settingsPath);
  return normalizeSettings(parsed);
}

export function writeSettings(settingsPath: string, settings: AgentStudioSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, yaml.dump(normalizeSettings(settings), { lineWidth: 100 }), "utf8");
}

export function updateSettings(settingsPath: string, updater: (settings: AgentStudioSettings) => AgentStudioSettings): AgentStudioSettings {
  const next = normalizeSettings(updater(readSettings(settingsPath)));
  writeSettings(settingsPath, next);
  return next;
}

export function updatePermissionMode(settingsPath: string, permissionMode: ChatPermissionMode): AgentStudioSettings {
  return updateSettings(settingsPath, (settings) => ({
    ...settings,
    chat: {
      ...settings.chat,
      permissionMode
    }
  }));
}

export function updateThemeMode(settingsPath: string, themeMode: ThemeMode): AgentStudioSettings {
  return updateSettings(settingsPath, (settings) => ({
    ...settings,
    ui: {
      ...settings.ui,
      themeMode
    }
  }));
}

export function updateRecentWorkspaceDirectories(settingsPath: string, workspacePath: string): AgentStudioSettings {
  return updateSettings(settingsPath, (settings) => ({
    ...settings,
    workspace: {
      ...settings.workspace,
      recentDirectories: normalizeRecentDirectories([workspacePath, ...settings.workspace.recentDirectories])
    }
  }));
}

function readRawSettings(settingsPath: string): Partial<AgentStudioSettings> {
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const parsed = yaml.load(fs.readFileSync(settingsPath, "utf8")) ?? {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Partial<AgentStudioSettings>) : {};
  } catch {
    return {};
  }
}

function normalizeSettings(input: Partial<AgentStudioSettings>): AgentStudioSettings {
  return {
    ui: {
      themeMode: normalizeThemeMode(input.ui?.themeMode)
    },
    chat: {
      permissionMode: normalizePermissionMode(input.chat?.permissionMode)
    },
    connector: {
      xhs: {
        selected_account: normalizeProfileKey(input.connector?.xhs?.selected_account)
      },
      wechat: {
        selected_account: normalizeProfileKey(input.connector?.wechat?.selected_account)
      }
    },
    workspace: {
      recentDirectories: normalizeRecentDirectories(input.workspace?.recentDirectories)
    },
    skills: {
      installed: normalizeInstalledSkills(input.skills?.installed),
      disabled: normalizeDisabledSkills(input.skills?.disabled)
    }
  };
}

function normalizePermissionMode(value: unknown): ChatPermissionMode {
  return typeof value === "string" && VALID_PERMISSION_MODES.has(value as ChatPermissionMode) ? (value as ChatPermissionMode) : defaultSettings.chat.permissionMode;
}

export function normalizeThemeMode(value: unknown): ThemeMode {
  return typeof value === "string" && VALID_THEME_MODES.has(value as ThemeMode) ? (value as ThemeMode) : defaultSettings.ui.themeMode;
}

function normalizeProfileKey(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(trimmed) ? trimmed : "";
}

function normalizeDisabledSkills(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))).sort();
}

function normalizeRecentDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const item of value) {
    const directory = normalizeDirectory(item);
    if (!directory) continue;
    const key = process.platform === "win32" ? directory.toLowerCase() : directory;
    if (seen.has(key)) continue;
    seen.add(key);
    directories.push(directory);
    if (directories.length >= MAX_RECENT_WORKSPACE_DIRECTORIES) break;
  }
  return directories;
}

function normalizeDirectory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const expanded = expandHome(trimmed);
  return path.normalize(path.isAbsolute(expanded) ? expanded : path.resolve(os.homedir(), expanded));
}

function normalizeInstalledSkills(input: unknown): AgentStudioSettings["skills"]["installed"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const installed: AgentStudioSettings["skills"]["installed"] = {};
  for (const [name, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!isValidSkillName(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const agent = readString(record.agent);
    const dirName = readString(record.dirName);
    const source = readString(record.source);
    const version = readString(record.version);
    if (!agent || !dirName || (source !== "builtin" && source !== "user" && source !== "market")) continue;
    installed[name] = version ? { agent, dirName, source, version } : { agent, dirName, source };
  }
  return installed;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isValidSkillName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name);
}

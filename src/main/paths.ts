import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import type { AgentStudioConfig, ImageProviderConfig, ModelProviderConfig, RuntimePaths } from "../shared/types";

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function getRuntimePaths(): RuntimePaths {
  const root = path.join(os.homedir(), ".agentstudio");
  const agents = path.join(root, "agents");
  const defaultAgent = path.join(agents, "orchestrator");
  const settingsDir = path.join(root, "settings");
  const userData = path.join(root, "user-data");
  const runtime = path.join(root, "runtime");
  return {
    root,
    agents,
    defaultAgent,
    config: path.join(root, "config.yml"),
    settings: path.join(root, "settings.yml"),
    settingsDir,
    modelProviders: path.join(settingsDir, "model-providers.yml"),
    imageProviders: path.join(settingsDir, "image-providers.yml"),
    database: path.join(root, "agentstudio.sqlite"),
    workspace: path.join(root, "workspace"),
    skills: path.join(defaultAgent, "skills"),
    userResourceSkills: path.join(root, "user-resources", "skills"),
    userProfile: path.join(root, "user-profile"),
    userData,
    runtime
  };
}

export const defaultConfig: AgentStudioConfig = {
  provider: {
    id: "",
    baseUrl: "",
    apiKey: "",
    model: ""
  },
  imageProvider: {
    id: "",
    name: "",
    providerType: "",
    baseUrl: "",
    apiKey: "",
    model: ""
  },
  workspace: {
    defaultDir: "~/.agentstudio/workspace"
  },
  user: {
    name: "默认用户",
    avatar: ""
  }
};

export function ensureRuntimeLayout(): RuntimePaths {
  const paths = getRuntimePaths();
  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.agents, { recursive: true });
  fs.mkdirSync(paths.defaultAgent, { recursive: true });
  fs.mkdirSync(paths.workspace, { recursive: true });
  fs.mkdirSync(paths.skills, { recursive: true });
  fs.mkdirSync(paths.userResourceSkills, { recursive: true });
  fs.mkdirSync(paths.userProfile, { recursive: true });
  fs.mkdirSync(paths.userData, { recursive: true });
  fs.mkdirSync(paths.runtime, { recursive: true });
  fs.mkdirSync(path.join(paths.runtime, "xhs-cli-processes"), { recursive: true });
  fs.mkdirSync(paths.settingsDir, { recursive: true });

  if (!fs.existsSync(paths.config)) {
    fs.writeFileSync(paths.config, yaml.dump(defaultConfig, { lineWidth: 100 }), "utf8");
  }

  return paths;
}

export function readConfig(): AgentStudioConfig {
  const paths = ensureRuntimeLayout();
  const parsed = readRawConfig(paths.config);

  return {
    provider: {
      id: normalizeConfigString(parsed.provider?.id),
      baseUrl: normalizeConfigString(parsed.provider?.baseUrl),
      apiKey: normalizeConfigString(parsed.provider?.apiKey),
      model: normalizeConfigString(parsed.provider?.model)
    },
    imageProvider: normalizeImageProviderConfig(parsed.imageProvider),
    workspace: {
      defaultDir: normalizeConfigString(parsed.workspace?.defaultDir) || defaultConfig.workspace.defaultDir
    },
    user: {
      name: normalizeConfigString(parsed.user?.name) || defaultConfig.user.name,
      avatar: normalizeConfigString(parsed.user?.avatar)
    }
  };
}

export function needsProviderOnboarding(config: AgentStudioConfig): boolean {
  return !config.provider.baseUrl.trim() || !config.provider.apiKey.trim() || !config.provider.model.trim();
}

export function writeProviderConfig(configPath: string, provider: ModelProviderConfig): AgentStudioConfig {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const raw = readRawConfig(configPath);
  const next: AgentStudioConfig = {
    provider: {
      id: provider.id.trim(),
      baseUrl: provider.baseUrl.trim(),
      apiKey: provider.apiKey.trim(),
      model: provider.model.trim()
    },
    imageProvider: normalizeImageProviderConfig(raw.imageProvider),
    workspace: {
      defaultDir: normalizeConfigString(raw.workspace?.defaultDir) || defaultConfig.workspace.defaultDir
    },
    user: {
      name: normalizeConfigString(raw.user?.name) || defaultConfig.user.name,
      avatar: normalizeConfigString(raw.user?.avatar)
    }
  };
  fs.writeFileSync(configPath, yaml.dump(next, { lineWidth: 100 }), "utf8");
  return next;
}

function readRawConfig(configPath: string): Partial<AgentStudioConfig> {
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, "utf8")) ?? {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Partial<AgentStudioConfig>) : {};
  } catch {
    return {};
  }
}

function normalizeConfigString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeImageProviderConfig(value: unknown): ImageProviderConfig {
  const provider = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<ImageProviderConfig> : {};
  return {
    id: normalizeConfigString(provider.id),
    name: normalizeConfigString(provider.name),
    providerType: normalizeImageProviderType(provider.providerType),
    baseUrl: normalizeConfigString(provider.baseUrl),
    apiKey: normalizeConfigString(provider.apiKey),
    model: normalizeConfigString(provider.model)
  };
}

function normalizeImageProviderType(value: unknown): ImageProviderConfig["providerType"] {
  if (
    value === "doubao" ||
    value === "openai" ||
    value === "gemini" ||
    value === "dashscope" ||
    value === "minimax" ||
    value === "openai-compatible"
  ) {
    return value;
  }
  return "";
}

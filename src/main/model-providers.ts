import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type {
  AgentStudioConfig,
  ImageProviderConfig,
  ImageProviderDefinition,
  ImageProviderSettings,
  ImageProviderType,
  ModelProviderConfig,
  ModelProviderDefinition,
  ModelProviderSettings,
  SaveImageProviderSettingsInput,
  SaveModelProviderSettingsInput
} from "../shared/types";

export function readModelProviderSettings(settingsPath: string): ModelProviderSettings {
  if (!fs.existsSync(settingsPath)) return { providers: [] };
  const parsed = readRawSettings(settingsPath);
  return normalizeModelProviderSettings(parsed);
}

export function readImageProviderSettings(settingsPath: string): ImageProviderSettings {
  if (!fs.existsSync(settingsPath)) return { imageProviders: [] };
  const parsed = readRawSettings(settingsPath);
  return normalizeImageProviderSettings(parsed);
}

export function normalizeSaveModelProviderSettingsInput(value: SaveModelProviderSettingsInput): SaveModelProviderSettingsInput {
  const settings = normalizeModelProviderSettings(value?.settings);
  const selectedProviderId = normalizeString(value?.selectedProviderId);

  if (settings.providers.length === 0) throw new Error("请至少添加一个普通模型供应商。");
  if (!settings.providers.some((provider) => provider.id === selectedProviderId)) {
    throw new Error("请选择当前普通模型供应商。");
  }

  return { settings, selectedProviderId };
}

export function normalizeSaveImageProviderSettingsInput(value: SaveImageProviderSettingsInput): SaveImageProviderSettingsInput {
  const settings = normalizeImageProviderSettings(value?.settings);
  const selectedImageProviderId = normalizeString(value?.selectedImageProviderId);

  if (settings.imageProviders.length > 0 && !settings.imageProviders.some((provider) => provider.id === selectedImageProviderId)) {
    throw new Error("请选择当前图片模型供应商。");
  }

  return { settings, selectedImageProviderId };
}

export function createInitialModelProviderSettings(id: string, provider: ModelProviderConfig): ModelProviderSettings {
  return normalizeModelProviderSettings({
    providers: [{
      id,
      name: "默认模型供应商",
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model
    }]
  });
}

export function modelProviderSettingsEqual(left: ModelProviderSettings, right: ModelProviderSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function imageProviderSettingsEqual(left: ImageProviderSettings, right: ImageProviderSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function writeModelProviderSettings(settingsPath: string, settings: ModelProviderSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tempPath = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, yaml.dump(settings, { lineWidth: 120, noRefs: true }), "utf8");
  fs.renameSync(tempPath, settingsPath);
}

export function writeImageProviderSettings(settingsPath: string, settings: ImageProviderSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tempPath = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, yaml.dump(settings, { lineWidth: 120, noRefs: true }), "utf8");
  fs.renameSync(tempPath, settingsPath);
}

export function writeActiveModelProviderConfig(
  configPath: string,
  currentConfig: AgentStudioConfig,
  input: SaveModelProviderSettingsInput
): AgentStudioConfig {
  const provider = input.settings.providers.find((item) => item.id === input.selectedProviderId);
  if (!provider) throw new Error("当前普通模型供应商不存在。");
  const firstModel = splitModels(provider.model)[0];
  if (!firstModel) throw new Error("当前普通模型供应商至少需要一个模型。");

  const next: AgentStudioConfig = {
    provider: {
      id: provider.id,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: firstModel
    },
    imageProvider: currentConfig.imageProvider,
    workspace: currentConfig.workspace,
    user: currentConfig.user
  };
  writeConfig(configPath, next);
  return next;
}

export function writeActiveModelConfig(
  configPath: string,
  currentConfig: AgentStudioConfig,
  model: string
): AgentStudioConfig {
  const next: AgentStudioConfig = {
    provider: {
      ...currentConfig.provider,
      model: model.trim()
    },
    imageProvider: currentConfig.imageProvider,
    workspace: currentConfig.workspace,
    user: currentConfig.user
  };
  writeConfig(configPath, next);
  return next;
}

export function writeActiveImageProviderConfig(
  configPath: string,
  currentConfig: AgentStudioConfig,
  input: SaveImageProviderSettingsInput
): AgentStudioConfig {
  const imageProvider = input.settings.imageProviders.find((item) => item.id === input.selectedImageProviderId);
  const next: AgentStudioConfig = {
    provider: currentConfig.provider,
    imageProvider: imageProvider ? toImageProviderConfig(imageProvider) : emptyImageProviderConfig(),
    workspace: currentConfig.workspace,
    user: currentConfig.user
  };
  writeConfig(configPath, next);
  return next;
}

function writeConfig(configPath: string, next: AgentStudioConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, yaml.dump(next, { lineWidth: 120, noRefs: true }), "utf8");
  fs.renameSync(tempPath, configPath);
}

export function splitModels(value: string): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of value.split(",")) {
    const model = item.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

function normalizeModelProviderSettings(value: unknown): ModelProviderSettings {
  const record = isRecord(value) ? value : {};
  return {
    providers: normalizeProviders(record.providers)
  };
}

function normalizeImageProviderSettings(value: unknown): ImageProviderSettings {
  const record = isRecord(value) ? value : {};
  return {
    imageProviders: normalizeImageProviders(record.imageProviders)
  };
}

function normalizeProviders(value: unknown): ModelProviderDefinition[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const providers: ModelProviderDefinition[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const provider = {
      id: normalizeString(item.id),
      name: normalizeString(item.name),
      baseUrl: normalizeString(item.baseUrl),
      apiKey: normalizeString(item.apiKey),
      model: splitModels(normalizeString(item.model)).join(",")
    };
    if (!provider.id || ids.has(provider.id)) throw new Error("模型供应商 id 必须唯一且不能为空。");
    if (!provider.name || !provider.baseUrl || !provider.apiKey || !provider.model) {
      throw new Error(`请完整填写普通模型供应商“${provider.name || provider.id}”。`);
    }
    ids.add(provider.id);
    providers.push(provider);
  }
  return providers;
}

function normalizeImageProviders(value: unknown): ImageProviderDefinition[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const providers: ImageProviderDefinition[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (isLegacyImageProvider(item)) continue;
    const provider = {
      id: normalizeString(item.id),
      name: normalizeString(item.name),
      providerType: normalizeImageProviderType(item.providerType),
      baseUrl: normalizeString(item.baseUrl),
      apiKey: normalizeString(item.apiKey),
      model: normalizeString(item.model)
    };
    if (!provider.id || ids.has(provider.id)) throw new Error("图片供应商 id 必须唯一且不能为空。");
    if (!provider.name || !provider.providerType || !provider.baseUrl || !provider.apiKey || !provider.model) {
      throw new Error(`请完整填写图片模型供应商“${provider.name || provider.id}”。`);
    }
    ids.add(provider.id);
    providers.push(provider as ImageProviderDefinition);
  }
  return providers;
}

function readRawSettings(settingsPath: string): unknown {
  try {
    return yaml.load(fs.readFileSync(settingsPath, "utf8")) ?? {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`模型供应商配置解析失败：${message}`);
  }
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeImageProviderType(value: unknown): ImageProviderType | "" {
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

function isLegacyImageProvider(value: Record<string, unknown>): boolean {
  return typeof value.endpoint === "string" && value.providerType === undefined && value.baseUrl === undefined;
}

function toImageProviderConfig(provider: ImageProviderDefinition): ImageProviderConfig {
  return {
    id: provider.id,
    name: provider.name,
    providerType: provider.providerType,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model
  };
}

function emptyImageProviderConfig(): ImageProviderConfig {
  return {
    id: "",
    name: "",
    providerType: "",
    baseUrl: "",
    apiKey: "",
    model: ""
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

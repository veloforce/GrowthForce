import type { AutomationIntervalUnit, AutomationScheduleConfig, AutomationScheduleType, AutomationTask, AutomationTaskInput } from "./types";

const retryDelaysMinutes = [1, 5, 15, 30];
const maxRetryDelayMinutes = 180;

export function normalizeAutomationTaskInput(input: AutomationTaskInput): AutomationTaskInput {
  const name = input.name.trim();
  const description = input.description.trim();
  const workspacePath = input.workspacePath.trim();
  if (!name) throw new Error("请输入任务名称");
  if (!description) throw new Error("请输入任务描述");
  if (!workspacePath) throw new Error("请选择任务目录");
  const scheduleType = normalizeScheduleType(input.scheduleType);
  const scheduleConfig = normalizeScheduleConfig(scheduleType, input.scheduleConfig);
  const maxRetries = Math.max(0, Math.min(20, Math.floor(Number(input.maxRetries) || 0)));
  const maxRuns = scheduleType === "interval" ? normalizeOptionalPositiveInteger(input.maxRuns) : null;
  return {
    name,
    description,
    workspacePath,
    scheduleType,
    scheduleConfig,
    maxRetries,
    maxRuns,
    connectorBindings: input.connectorBindings ?? {},
    selectedSkills: input.selectedSkills ?? [],
    attachments: input.attachments ?? [],
    enabled: input.enabled !== false
  };
}

export function calculateNextRunAt(input: Pick<AutomationTask, "scheduleType" | "scheduleConfig"> | AutomationTaskInput, from = new Date()): string | null {
  const type = input.scheduleType;
  const config = normalizeScheduleConfig(type, input.scheduleConfig);
  const base = new Date(from.getTime());
  base.setSeconds(0, 0);

  if (type === "once") {
    const runAt = config.runAt ? new Date(config.runAt) : null;
    if (!runAt || Number.isNaN(runAt.getTime()) || runAt.getTime() <= from.getTime()) return null;
    return runAt.toISOString();
  }

  if (type === "interval") {
    return new Date(from.getTime() + intervalMilliseconds(config)).toISOString();
  }

  if (type === "hourly") {
    const next = new Date(base);
    next.setMinutes(config.minute ?? 0, 0, 0);
    if (next.getTime() <= from.getTime()) next.setHours(next.getHours() + 1);
    return next.toISOString();
  }

  if (type === "daily" || type === "weekday") {
    const allowedDays = type === "weekday" ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6];
    return findNextByDays(from, allowedDays, config.hour ?? 9, config.minute ?? 0, 8);
  }

  if (type === "weekly") {
    const allowedDays = (config.weekdays ?? [1]).map((day) => (day === 7 ? 0 : day));
    return findNextByDays(from, allowedDays, config.hour ?? 9, config.minute ?? 0, 14);
  }

  const monthDays = config.monthDays ?? [1];
  for (let offset = 0; offset <= 24; offset += 1) {
    const probe = new Date(from);
    probe.setDate(1);
    probe.setMonth(probe.getMonth() + offset);
    for (const monthDay of monthDays) {
      const next = new Date(probe);
      next.setDate(monthDay);
      next.setHours(config.hour ?? 9, config.minute ?? 0, 0, 0);
      if (next.getMonth() !== probe.getMonth()) continue;
      if (next.getTime() > from.getTime()) return next.toISOString();
    }
  }
  return null;
}

export function calculateAutomationDispatchPlan(task: AutomationTask, scheduledAt: string): { enabled: boolean; nextRunAt: string | null } {
  const reachedRunLimit = task.maxRuns !== null && task.runCount + 1 >= task.maxRuns;
  const enabled = task.scheduleType !== "once" && !reachedRunLimit;
  return {
    enabled,
    nextRunAt: enabled ? calculateNextRunAt(task, new Date(scheduledAt)) : null
  };
}

export function getRetryDelayMs(attemptCount: number): number {
  const retryIndex = Math.max(0, attemptCount - 1);
  const minutes = retryDelaysMinutes[retryIndex] ?? Math.min(maxRetryDelayMinutes, retryDelaysMinutes.at(-1)! * 2 ** (retryIndex - retryDelaysMinutes.length + 1));
  return Math.min(maxRetryDelayMinutes, minutes) * 60_000;
}

export function formatAutomationSchedule(type: AutomationScheduleType, config: AutomationScheduleConfig): string {
  const normalized = normalizeScheduleConfig(type, config);
  if (type === "once") return normalized.runAt ? `一次性 ${formatDateTime(normalized.runAt)}` : "一次性";
  if (type === "interval") return `每 ${normalized.intervalValue ?? 1} ${formatIntervalUnit(normalized.intervalUnit ?? "minute")}`;
  if (type === "hourly") return `每小时 ${pad(normalized.minute ?? 0)} 分`;
  if (type === "daily") return `每天 ${pad(normalized.hour ?? 9)}:${pad(normalized.minute ?? 0)}`;
  if (type === "weekday") return `工作日 ${pad(normalized.hour ?? 9)}:${pad(normalized.minute ?? 0)}`;
  if (type === "weekly") return `每周 ${formatWeekdays(normalized.weekdays ?? [1])} ${pad(normalized.hour ?? 9)}:${pad(normalized.minute ?? 0)}`;
  return `每月 ${formatMonthDays(normalized.monthDays ?? [1])} ${pad(normalized.hour ?? 9)}:${pad(normalized.minute ?? 0)}`;
}

export function formatAutomationStatus(status: string): string {
  if (status === "succeeded") return "成功";
  if (status === "failed") return "失败";
  if (status === "waiting_resource") return "等待账号空闲";
  if (status === "retrying") return "等待重试";
  return "运行中";
}

function normalizeScheduleType(value: unknown): AutomationScheduleType {
  return value === "once" || value === "interval" || value === "hourly" || value === "daily" || value === "weekday" || value === "weekly" || value === "monthly" ? value : "daily";
}

function normalizeScheduleConfig(type: AutomationScheduleType, input: AutomationScheduleConfig): AutomationScheduleConfig {
  if (type === "once") {
    const runAt = typeof input.runAt === "string" ? input.runAt : "";
    if (!runAt || Number.isNaN(new Date(runAt).getTime())) throw new Error("请选择一次性任务时间");
    return { runAt };
  }
  if (type === "interval") {
    const intervalUnit = normalizeIntervalUnit(input.intervalUnit);
    const legacyMinutes = input.intervalValue === undefined && input.intervalMinutes !== undefined ? input.intervalMinutes : undefined;
    return {
      intervalValue: normalizeNumber(input.intervalValue ?? legacyMinutes, 1, Number.MAX_SAFE_INTEGER, 1),
      intervalUnit
    };
  }
  if (type === "hourly") return { minute: normalizeNumber(input.minute, 0, 59, 0) };
  if (type === "daily" || type === "weekday") {
    return { hour: normalizeNumber(input.hour, 0, 23, 9), minute: normalizeNumber(input.minute, 0, 59, 0) };
  }
  if (type === "weekly") {
    const weekdays = normalizeList(input.weekdays, 1, 7, [1]);
    return { weekdays, hour: normalizeNumber(input.hour, 0, 23, 9), minute: normalizeNumber(input.minute, 0, 59, 0) };
  }
  const monthDays = normalizeList(input.monthDays, 1, 31, [1]);
  return { monthDays, hour: normalizeNumber(input.hour, 0, 23, 9), minute: normalizeNumber(input.minute, 0, 59, 0) };
}

function normalizeOptionalPositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  return normalizeNumber(value, 1, Number.MAX_SAFE_INTEGER, 1);
}

function normalizeIntervalUnit(value: unknown): AutomationIntervalUnit {
  return value === "hour" || value === "day" ? value : "minute";
}

function intervalMilliseconds(config: AutomationScheduleConfig): number {
  const value = config.intervalValue ?? config.intervalMinutes ?? 1;
  const multiplier = config.intervalUnit === "day" ? 24 * 60 * 60_000 : config.intervalUnit === "hour" ? 60 * 60_000 : 60_000;
  return value * multiplier;
}

function formatIntervalUnit(unit: AutomationIntervalUnit): string {
  if (unit === "hour") return "小时";
  if (unit === "day") return "天";
  return "分钟";
}

function normalizeNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeList(value: unknown, min: number, max: number, fallback: number[]): number[] {
  if (!Array.isArray(value)) return fallback;
  const next = Array.from(new Set(value.map((item) => normalizeNumber(item, min, max, Number.NaN)).filter((item) => Number.isFinite(item)))).sort((a, b) => a - b);
  return next.length > 0 ? next : fallback;
}

function findNextByDays(from: Date, allowedDays: number[], hour: number, minute: number, maxDays: number): string | null {
  for (let offset = 0; offset <= maxDays; offset += 1) {
    const next = new Date(from);
    next.setDate(next.getDate() + offset);
    next.setHours(hour, minute, 0, 0);
    if (!allowedDays.includes(next.getDay())) continue;
    if (next.getTime() > from.getTime()) return next.toISOString();
  }
  return null;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatWeekdays(days: number[]): string {
  const labels = ["一", "二", "三", "四", "五", "六", "日"];
  return days.map((day) => `周${labels[day - 1] ?? "一"}`).join("、");
}

function formatMonthDays(days: number[]): string {
  return days.map((day) => `${day}日`).join("、");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

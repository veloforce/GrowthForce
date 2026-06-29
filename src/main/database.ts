import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from "sql.js";
import { randomUUID } from "node:crypto";
import type { AutomationRun, AutomationRunExecutionHistoryItem, AutomationRunStatus, AutomationTask, AutomationTaskInput, ConnectorAccount, ConnectorAccountOpsState, ConnectorAccountStatus, ConnectorPlatform, SessionOrigin, SessionRecord, SessionStatus } from "../shared/types";

type SessionRow = Record<string, SqlValue>;

export class AppDatabase {
  private constructor(
    private readonly filename: string,
    private readonly db: Database
  ) {}

  static async open(filename: string): Promise<AppDatabase> {
    const SQL = await loadSqlJs();
    const data = fs.existsSync(filename) ? fs.readFileSync(filename) : undefined;
    const db = new SQL.Database(data);
    const appDb = new AppDatabase(filename, db);
    appDb.migrate();
    appDb.persist();
    return appDb;
  }

  listSessions(input: { includeAutomation?: boolean } = {}): SessionRecord[] {
    const rows = input.includeAutomation
      ? this.selectRows("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 100")
      : this.selectRows("SELECT * FROM sessions WHERE origin = 'manual' ORDER BY updated_at DESC LIMIT 100");
    return rows.map(mapSession);
  }

  getSession(id: number): SessionRecord | null {
    const rows = this.selectRows("SELECT * FROM sessions WHERE id = ?", [id]);
    return rows[0] ? mapSession(rows[0]) : null;
  }

  createSession(input: { prompt: string; workspacePath: string; origin?: SessionOrigin; title?: string; agentName?: string }): SessionRecord {
    const now = new Date().toISOString();
    const localSessionId = randomUUID();
    const title = input.title?.trim().slice(0, 48) || input.prompt.trim().slice(0, 48) || `新会话 ${randomUUID().slice(0, 8)}`;
    const origin = input.origin ?? "manual";
    this.db.run(
      "INSERT INTO sessions (local_session_id, title, workspace_path, agent_name, status, origin, created_at, updated_at, last_opened_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)",
      [localSessionId, title, input.workspacePath, normalizeAgentName(input.agentName), origin, now, now, now]
    );
    this.persist();
    const session = this.getSessionByLocalId(localSessionId);
    if (!session) throw new Error("Failed to create session");
    return session;
  }

  markRunning(id: number): void {
    this.updateStatus(id, "running");
  }

  listConnectorAccounts(platform?: ConnectorPlatform): ConnectorAccount[] {
    const rows = platform
      ? this.selectRows("SELECT * FROM connector_accounts WHERE platform = ? ORDER BY created_at DESC, id DESC", [platform])
      : this.selectRows("SELECT * FROM connector_accounts ORDER BY platform ASC, created_at DESC, id DESC");
    return rows.map(mapConnectorAccount);
  }

  getConnectorAccountByProfileKey(platform: ConnectorPlatform, profileKey: string): ConnectorAccount | null {
    const rows = this.selectRows("SELECT * FROM connector_accounts WHERE platform = ? AND profile_key = ? LIMIT 1", [normalizeConnectorPlatform(platform), normalizeRequiredText(profileKey, "profileKey")]);
    return rows[0] ? mapConnectorAccount(rows[0]) : null;
  }

  getConnectorAccountByAccountId(platform: ConnectorPlatform, accountId: string): ConnectorAccount | null {
    const rows = this.selectRows("SELECT * FROM connector_accounts WHERE platform = ? AND account_id = ? LIMIT 1", [normalizeConnectorPlatform(platform), normalizeRequiredText(accountId, "accountId")]);
    return rows[0] ? mapConnectorAccount(rows[0]) : null;
  }

  getConnectorCredentialSecret(platform: ConnectorPlatform, profileKey: string): string | null {
    const rows = this.selectRows("SELECT credential_secret FROM connector_accounts WHERE platform = ? AND profile_key = ? LIMIT 1", [normalizeConnectorPlatform(platform), normalizeRequiredText(profileKey, "profileKey")]);
    return rows[0] ? toNullableString(rows[0].credential_secret) : null;
  }

  deleteConnectorAccount(platform: ConnectorPlatform, profileKey: string): void {
    this.db.run("DELETE FROM connector_accounts WHERE platform = ? AND profile_key = ?", [normalizeConnectorPlatform(platform), normalizeRequiredText(profileKey, "profileKey")]);
    this.persist();
  }

  updateConnectorAccountOpsState(platform: ConnectorPlatform, profileKey: string, patch: Partial<ConnectorAccountOpsState>): ConnectorAccount {
    const account = this.getConnectorAccountByProfileKey(platform, profileKey);
    if (!account) throw new Error("账号不存在");
    const now = new Date().toISOString();
    const opsState = normalizeConnectorOpsState({ ...account.opsState, ...patch });
    this.db.run(
      "UPDATE connector_accounts SET ops_state = ?, updated_at = ? WHERE platform = ? AND profile_key = ?",
      [JSON.stringify(writeConnectorOpsState(opsState)), now, normalizeConnectorPlatform(platform), normalizeRequiredText(profileKey, "profileKey")]
    );
    this.persist();
    const updated = this.getConnectorAccountByProfileKey(platform, profileKey);
    if (!updated) throw new Error("账号不存在");
    return updated;
  }

  upsertConnectorAccount(input: {
    platform: ConnectorPlatform;
    profileKey: string;
    accountId?: string | null;
    accountHandle?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    status: ConnectorAccountStatus;
    lastAuthorizedAt?: string | null;
    credentialSecret?: string | null;
  }): ConnectorAccount {
    const now = new Date().toISOString();
    const platform = normalizeConnectorPlatform(input.platform);
    const profileKey = normalizeRequiredText(input.profileKey, "profileKey");
    const accountId = normalizeOptionalText(input.accountId);
    const accountHandle = normalizeOptionalText(input.accountHandle);
    const existing = accountId
      ? this.selectRows("SELECT * FROM connector_accounts WHERE platform = ? AND account_id = ? LIMIT 1", [platform, accountId])[0]
        ?? this.selectRows("SELECT * FROM connector_accounts WHERE platform = ? AND profile_key = ? LIMIT 1", [platform, profileKey])[0]
      : this.selectRows("SELECT * FROM connector_accounts WHERE platform = ? AND profile_key = ? LIMIT 1", [platform, profileKey])[0];
    if (existing) {
      this.db.run("DELETE FROM connector_accounts WHERE platform = ? AND profile_key = ? AND id != ? AND account_id IS NULL", [platform, profileKey, Number(existing.id)]);
      this.db.run(
        "UPDATE connector_accounts SET profile_key = ?, account_id = COALESCE(?, account_id), account_handle = COALESCE(?, account_handle), display_name = COALESCE(?, display_name), avatar_url = COALESCE(?, avatar_url), credential_secret = COALESCE(?, credential_secret), status = ?, updated_at = ?, last_authorized_at = COALESCE(?, last_authorized_at) WHERE id = ?",
        [profileKey, accountId, accountHandle, normalizeOptionalText(input.displayName), normalizeOptionalText(input.avatarUrl), normalizeOptionalText(input.credentialSecret), input.status, now, normalizeOptionalText(input.lastAuthorizedAt), Number(existing.id)]
      );
      this.persist();
      const updated = this.selectRows("SELECT * FROM connector_accounts WHERE id = ?", [Number(existing.id)])[0];
      if (!updated) throw new Error("Failed to update connector account");
      return mapConnectorAccount(updated);
    }
    this.db.run(
      "INSERT INTO connector_accounts (platform, profile_key, account_id, account_handle, display_name, avatar_url, credential_secret, status, created_at, updated_at, last_authorized_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [platform, profileKey, accountId, accountHandle, normalizeOptionalText(input.displayName), normalizeOptionalText(input.avatarUrl), normalizeOptionalText(input.credentialSecret), input.status, now, now, normalizeOptionalText(input.lastAuthorizedAt)]
    );
    this.persist();
    const id = Number(this.selectRows("SELECT MAX(id) AS id FROM connector_accounts")[0]?.id);
    const account = this.selectRows("SELECT * FROM connector_accounts WHERE id = ?", [id])[0];
    if (!account) throw new Error("Failed to create connector account");
    return mapConnectorAccount(account);
  }

  completeSession(id: number, input: { sdkSessionId?: string; jsonlPath?: string; status?: SessionStatus }): void {
    const now = new Date().toISOString();
    this.db.run(
      "UPDATE sessions SET sdk_session_id = COALESCE(?, sdk_session_id), jsonl_path = COALESCE(?, jsonl_path), status = ?, updated_at = ?, last_opened_at = ? WHERE id = ?",
      [input.sdkSessionId ?? null, input.jsonlPath ?? null, input.status ?? "completed", now, now, id]
    );
    this.persist();
  }

  updateSdkSessionId(id: number, sdkSessionId: string): void {
    const now = new Date().toISOString();
    this.db.run("UPDATE sessions SET sdk_session_id = ?, updated_at = ?, last_opened_at = ? WHERE id = ?", [sdkSessionId, now, now, id]);
    this.persist();
  }

  updateJsonlPath(id: number, jsonlPath: string): void {
    const now = new Date().toISOString();
    this.db.run("UPDATE sessions SET jsonl_path = ?, updated_at = ?, last_opened_at = ? WHERE id = ?", [jsonlPath, now, now, id]);
    this.persist();
  }

  updateStatus(id: number, status: SessionStatus): void {
    const now = new Date().toISOString();
    this.db.run("UPDATE sessions SET status = ?, updated_at = ?, last_opened_at = ? WHERE id = ?", [status, now, now, id]);
    this.persist();
  }

  markRunningSessionsFailed(): number {
    const running = this.selectRows("SELECT id FROM sessions WHERE status = 'running'");
    if (running.length === 0) return 0;
    const now = new Date().toISOString();
    this.db.run("UPDATE sessions SET status = 'failed', updated_at = ?, last_opened_at = ? WHERE status = 'running'", [now, now]);
    this.persist();
    return running.length;
  }

  listAutomationTasks(): AutomationTask[] {
    return this.selectRows("SELECT * FROM automation_tasks ORDER BY created_at DESC, id DESC").map(mapAutomationTask);
  }

  getAutomationTask(id: number): AutomationTask | null {
    const rows = this.selectRows("SELECT * FROM automation_tasks WHERE id = ?", [id]);
    return rows[0] ? mapAutomationTask(rows[0]) : null;
  }

  createAutomationTask(input: AutomationTaskInput, nextRunAt: string | null): AutomationTask {
    const now = new Date().toISOString();
    this.db.run(
      "INSERT INTO automation_tasks (name, description, workspace_path, schedule_type, schedule_config, max_retries, max_runs, run_count, connector_bindings, selected_skills, attachments, enabled, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)",
      [input.name, input.description, input.workspacePath, input.scheduleType, JSON.stringify(input.scheduleConfig), input.maxRetries, input.maxRuns ?? null, JSON.stringify(input.connectorBindings ?? {}), JSON.stringify(input.selectedSkills ?? []), JSON.stringify(input.attachments ?? []), input.enabled === false ? 0 : 1, nextRunAt, now, now]
    );
    this.persist();
    const id = Number(this.selectRows("SELECT MAX(id) AS id FROM automation_tasks")[0]?.id);
    const task = this.getAutomationTask(id);
    if (!task) throw new Error("Failed to create automation task");
    return task;
  }

  updateAutomationTask(id: number, input: AutomationTaskInput, nextRunAt: string | null, resetRunCount = false): AutomationTask {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE automation_tasks SET name = ?, description = ?, workspace_path = ?, schedule_type = ?, schedule_config = ?, max_retries = ?, max_runs = ?, connector_bindings = ?, selected_skills = ?, attachments = ?, enabled = ?, next_run_at = ?, run_count = ${resetRunCount ? "0" : "run_count"}, updated_at = ? WHERE id = ?`,
      [input.name, input.description, input.workspacePath, input.scheduleType, JSON.stringify(input.scheduleConfig), input.maxRetries, input.maxRuns ?? null, JSON.stringify(input.connectorBindings ?? {}), JSON.stringify(input.selectedSkills ?? []), JSON.stringify(input.attachments ?? []), input.enabled === false ? 0 : 1, nextRunAt, now, id]
    );
    this.persist();
    const task = this.getAutomationTask(id);
    if (!task) throw new Error("Automation task not found");
    return task;
  }

  setAutomationTaskEnabled(id: number, enabled: boolean, nextRunAt: string | null): AutomationTask {
    const now = new Date().toISOString();
    this.db.run("UPDATE automation_tasks SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?", [enabled ? 1 : 0, nextRunAt, now, id]);
    this.persist();
    const task = this.getAutomationTask(id);
    if (!task) throw new Error("Automation task not found");
    return task;
  }

  updateAutomationTaskNextRunAt(id: number, nextRunAt: string | null): void {
    const now = new Date().toISOString();
    this.db.run("UPDATE automation_tasks SET next_run_at = ?, updated_at = ? WHERE id = ?", [nextRunAt, now, id]);
    this.persist();
  }

  recordAutomationTaskDispatch(id: number, nextRunAt: string | null, enabled: boolean): AutomationTask {
    const now = new Date().toISOString();
    this.db.run("UPDATE automation_tasks SET run_count = run_count + 1, next_run_at = ?, enabled = ?, updated_at = ? WHERE id = ?", [nextRunAt, enabled ? 1 : 0, now, id]);
    this.persist();
    const task = this.getAutomationTask(id);
    if (!task) throw new Error("Automation task not found");
    return task;
  }

  deleteAutomationTask(id: number): void {
    this.db.run("DELETE FROM automation_tasks WHERE id = ?", [id]);
    this.persist();
  }

  listAutomationRuns(): AutomationRun[] {
    return this.selectRows(`
      SELECT runs.*, COALESCE(tasks.name, runs.task_name_snapshot, '已删除任务') AS task_name
      FROM automation_runs runs
      LEFT JOIN automation_tasks tasks ON tasks.id = runs.task_id
      ORDER BY runs.created_at DESC
      LIMIT 200
    `).map(mapAutomationRun);
  }

  listAutomationRunsFiltered(input: { taskId?: number; statuses?: AutomationRunStatus[]; limit?: number; offset?: number } = {}): AutomationRun[] {
    const conditions: string[] = [];
    const params: SqlValue[] = [];
    if (input.taskId !== undefined) {
      conditions.push("runs.task_id = ?");
      params.push(input.taskId);
    }
    if (input.statuses && input.statuses.length > 0) {
      conditions.push(`runs.status IN (${input.statuses.map(() => "?").join(", ")})`);
      params.push(...input.statuses);
    }
    const limit = clampInteger(input.limit ?? 20, 1, 100);
    const offset = clampInteger(input.offset ?? 0, 0, 10_000);
    params.push(limit, offset);
    return this.selectRows(`
      SELECT runs.*, COALESCE(tasks.name, runs.task_name_snapshot, '已删除任务') AS task_name
      FROM automation_runs runs
      LEFT JOIN automation_tasks tasks ON tasks.id = runs.task_id
      ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY runs.created_at DESC, runs.id DESC
      LIMIT ? OFFSET ?
    `, params).map(mapAutomationRun);
  }

  getAutomationRun(id: number): AutomationRun | null {
    const rows = this.selectRows(`
      SELECT runs.*, COALESCE(tasks.name, runs.task_name_snapshot, '已删除任务') AS task_name
      FROM automation_runs runs
      LEFT JOIN automation_tasks tasks ON tasks.id = runs.task_id
      WHERE runs.id = ?
    `, [id]);
    return rows[0] ? mapAutomationRun(rows[0]) : null;
  }

  createAutomationRun(input: { task: AutomationTask; scheduledAt: string; status?: AutomationRunStatus }): AutomationRun {
    const now = new Date().toISOString();
    const status = input.status ?? "running";
    this.db.run(
      "INSERT INTO automation_runs (task_id, task_name_snapshot, scheduled_at, status, attempt_count, max_attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
      [input.task.id, input.task.name, input.scheduledAt, status, input.task.maxRetries + 1, now, now]
    );
    this.persist();
    const id = Number(this.selectRows("SELECT MAX(id) AS id FROM automation_runs")[0]?.id);
    const run = this.getAutomationRun(id);
    if (!run) throw new Error("Failed to create automation run");
    return run;
  }

  startAutomationRunAttempt(id: number, input: { sessionId: number; attemptCount: number }): void {
    const now = new Date().toISOString();
    this.db.run(
      "UPDATE automation_runs SET session_id = ?, started_at = COALESCE(started_at, ?), status = 'running', attempt_count = ?, next_retry_at = NULL, updated_at = ? WHERE id = ?",
      [input.sessionId, now, input.attemptCount, now, id]
    );
    this.persist();
  }

  completeAutomationRun(id: number, status: AutomationRunStatus, errorMessage: string | null = null): void {
    const now = new Date().toISOString();
    this.db.run("UPDATE automation_runs SET status = ?, ended_at = ?, next_retry_at = NULL, error_message = ?, updated_at = ? WHERE id = ?", [status, now, errorMessage, now, id]);
    this.persist();
  }

  scheduleAutomationRunRetry(id: number, input: { nextRetryAt: string; errorMessage: string }): void {
    const now = new Date().toISOString();
    this.db.run("UPDATE automation_runs SET status = 'retrying', next_retry_at = ?, error_message = ?, updated_at = ? WHERE id = ?", [input.nextRetryAt, input.errorMessage, now, id]);
    this.persist();
  }

  scheduleAutomationRunResourceWait(id: number, input: { nextCheckAt: string; errorMessage: string }): void {
    const now = new Date().toISOString();
    this.db.run("UPDATE automation_runs SET status = 'waiting_resource', next_retry_at = ?, error_message = ?, updated_at = ? WHERE id = ?", [input.nextCheckAt, input.errorMessage, now, id]);
    this.persist();
  }

  appendAutomationRunExecutionHistory(id: number, item: AutomationRunExecutionHistoryItem): void {
    const run = this.getAutomationRun(id);
    if (!run) throw new Error("Automation run not found");
    const now = new Date().toISOString();
    const history = [...run.executionHistory, normalizeAutomationRunHistoryItem(item)];
    this.db.run("UPDATE automation_runs SET execution_history = ?, updated_at = ? WHERE id = ?", [JSON.stringify(history), now, id]);
    this.persist();
  }

  hasOpenAutomationRunForTask(taskId: number): boolean {
    const rows = this.selectRows(
      "SELECT id FROM automation_runs WHERE task_id = ? AND status IN ('running', 'retrying', 'waiting_resource') LIMIT 1",
      [taskId]
    );
    return rows.length > 0;
  }

  listDueAutomationTasks(nowIso: string): AutomationTask[] {
    return this.selectRows("SELECT * FROM automation_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC", [nowIso]).map(mapAutomationTask);
  }

  listDueAutomationRunContinuations(nowIso: string): AutomationRun[] {
    return this.selectRows(`
      SELECT runs.*, COALESCE(tasks.name, runs.task_name_snapshot, '已删除任务') AS task_name
      FROM automation_runs runs
      LEFT JOIN automation_tasks tasks ON tasks.id = runs.task_id
      WHERE runs.status IN ('retrying', 'waiting_resource') AND runs.next_retry_at IS NOT NULL AND runs.next_retry_at <= ?
      ORDER BY runs.next_retry_at ASC, runs.created_at ASC
    `, [nowIso]).map(mapAutomationRun);
  }

  listDueAutomationRetries(nowIso: string): AutomationRun[] {
    return this.listDueAutomationRunContinuations(nowIso).filter((run) => run.status === "retrying");
  }

  getNextAutomationCandidate(): { at: string; kind: "task" | "retry" } | null {
    const rows = this.selectRows(`
      SELECT next_run_at AS at, 'task' AS kind FROM automation_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL
      UNION ALL
      SELECT next_retry_at AS at, 'retry' AS kind FROM automation_runs WHERE status IN ('retrying', 'waiting_resource') AND next_retry_at IS NOT NULL
      ORDER BY at ASC
      LIMIT 1
    `);
    if (!rows[0]?.at) return null;
    return { at: String(rows[0].at), kind: rows[0].kind === "retry" ? "retry" : "task" };
  }

  markOverdueAutomationRetriesFailed(nowIso: string): number {
    const rows = this.selectRows("SELECT id FROM automation_runs WHERE status = 'retrying' AND next_retry_at IS NOT NULL AND next_retry_at < ?", [nowIso]);
    if (rows.length === 0) return 0;
    const now = new Date().toISOString();
    this.db.run("UPDATE automation_runs SET status = 'failed', ended_at = ?, next_retry_at = NULL, error_message = '应用关闭期间错过重试', updated_at = ? WHERE status = 'retrying' AND next_retry_at IS NOT NULL AND next_retry_at < ?", [now, now, nowIso]);
    this.persist();
    return rows.length;
  }

  markOverdueAutomationResourceWaitsFailed(nowIso: string): number {
    const rows = this.selectRows("SELECT id FROM automation_runs WHERE status = 'waiting_resource' AND next_retry_at IS NOT NULL AND next_retry_at < ?", [nowIso]);
    if (rows.length === 0) return 0;
    const now = new Date().toISOString();
    this.db.run("UPDATE automation_runs SET status = 'failed', ended_at = ?, next_retry_at = NULL, error_message = '应用关闭期间错过账号资源等待', updated_at = ? WHERE status = 'waiting_resource' AND next_retry_at IS NOT NULL AND next_retry_at < ?", [now, now, nowIso]);
    this.persist();
    return rows.length;
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_session_id TEXT,
        sdk_session_id TEXT,
        agent_name TEXT NOT NULL DEFAULT 'orchestrator',
        title TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        jsonl_path TEXT,
        status TEXT NOT NULL CHECK(status IN ('idle', 'running', 'failed', 'completed', 'cancelled')),
        origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual', 'automation')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_sdk_session_id ON sessions(sdk_session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_origin_updated_at ON sessions(origin, updated_at DESC);
      CREATE TABLE IF NOT EXISTS connector_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL CHECK(platform IN ('xhs', 'wechat', 'douyin')),
        profile_key TEXT NOT NULL,
        account_id TEXT,
        account_handle TEXT,
        display_name TEXT,
        avatar_url TEXT,
        credential_secret TEXT,
        status TEXT NOT NULL CHECK(status IN ('unauthorized', 'authorizing', 'authorized', 'needs_refresh', 'error')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_authorized_at TEXT,
        ops_state TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS automation_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        schedule_type TEXT NOT NULL CHECK(schedule_type IN ('once', 'interval', 'hourly', 'daily', 'weekday', 'weekly', 'monthly')),
        schedule_config TEXT NOT NULL,
        max_retries INTEGER NOT NULL DEFAULT 0,
        max_runs INTEGER,
        run_count INTEGER NOT NULL DEFAULT 0,
        connector_bindings TEXT NOT NULL DEFAULT '{}',
        selected_skills TEXT NOT NULL DEFAULT '[]',
        attachments TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automation_tasks_next_run_at ON automation_tasks(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS automation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        task_name_snapshot TEXT NOT NULL,
        session_id INTEGER,
        scheduled_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('running', 'waiting_resource', 'retrying', 'succeeded', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        next_retry_at TEXT,
        error_message TEXT,
        execution_history TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automation_runs_created_at ON automation_runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_next_retry_at ON automation_runs(status, next_retry_at);
    `);
    this.ensureAutomationRunsStatusConstraint();
    this.db.run("CREATE INDEX IF NOT EXISTS idx_automation_runs_created_at ON automation_runs(created_at DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_automation_runs_next_retry_at ON automation_runs(status, next_retry_at)");
    this.ensureColumn("sessions", "local_session_id", "TEXT");
    this.ensureColumn("sessions", "agent_name", "TEXT NOT NULL DEFAULT 'orchestrator'");
    this.ensureColumn("sessions", "origin", "TEXT NOT NULL DEFAULT 'manual'");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_local_session_id ON sessions(local_session_id)");
    this.ensureColumn("connector_accounts", "profile_key", "TEXT");
    this.ensureColumn("connector_accounts", "account_id", "TEXT");
    this.ensureColumn("connector_accounts", "account_handle", "TEXT");
    this.ensureColumn("connector_accounts", "display_name", "TEXT");
    this.ensureColumn("connector_accounts", "avatar_url", "TEXT");
    this.ensureColumn("connector_accounts", "credential_secret", "TEXT");
    this.ensureColumn("connector_accounts", "status", "TEXT NOT NULL DEFAULT 'unauthorized'");
    this.ensureColumn("connector_accounts", "created_at", "TEXT");
    this.ensureColumn("connector_accounts", "updated_at", "TEXT");
    this.ensureColumn("connector_accounts", "last_authorized_at", "TEXT");
    this.ensureColumn("connector_accounts", "ops_state", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("automation_tasks", "max_runs", "INTEGER");
    this.ensureColumn("automation_tasks", "run_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("automation_tasks", "connector_bindings", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("automation_tasks", "selected_skills", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("automation_tasks", "attachments", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("automation_runs", "execution_history", "TEXT NOT NULL DEFAULT '[]'");
    const now = new Date().toISOString();
    this.db.run("UPDATE connector_accounts SET profile_key = COALESCE(NULLIF(profile_key, ''), COALESCE(NULLIF(account_id, ''), 'legacy_' || id)) WHERE profile_key IS NULL OR profile_key = ''");
    this.db.run("UPDATE connector_accounts SET created_at = COALESCE(NULLIF(created_at, ''), ?) WHERE created_at IS NULL OR created_at = ''", [now]);
    this.db.run("UPDATE connector_accounts SET updated_at = COALESCE(NULLIF(updated_at, ''), ?) WHERE updated_at IS NULL OR updated_at = ''", [now]);
    this.db.run("UPDATE connector_accounts SET status = 'needs_refresh' WHERE status IS NULL OR status = '' OR status = 'expired'");
    this.db.run("UPDATE connector_accounts SET status = 'error' WHERE status NOT IN ('unauthorized', 'authorizing', 'authorized', 'needs_refresh', 'error')");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_accounts_platform_profile_key ON connector_accounts(platform, profile_key)");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_accounts_platform_account_id ON connector_accounts(platform, account_id) WHERE account_id IS NOT NULL");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_connector_accounts_platform_updated_at ON connector_accounts(platform, updated_at DESC)");
  }

  private ensureAutomationRunsStatusConstraint(): void {
    const row = this.selectRows("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'automation_runs'")[0];
    const sql = typeof row?.sql === "string" ? row.sql : "";
    if (sql.includes("waiting_resource")) return;
    const hasExecutionHistory = this.hasColumn("automation_runs", "execution_history");
    this.db.run("ALTER TABLE automation_runs RENAME TO automation_runs_old_status_check");
    this.db.run(`
      CREATE TABLE automation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        task_name_snapshot TEXT NOT NULL,
        session_id INTEGER,
        scheduled_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('running', 'waiting_resource', 'retrying', 'succeeded', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        next_retry_at TEXT,
        error_message TEXT,
        execution_history TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.run(`
      INSERT INTO automation_runs (
        id, task_id, task_name_snapshot, session_id, scheduled_at, started_at, ended_at,
        status, attempt_count, max_attempts, next_retry_at, error_message, execution_history, created_at, updated_at
      )
      SELECT
        id, task_id, task_name_snapshot, session_id, scheduled_at, started_at, ended_at,
        status, attempt_count, max_attempts, next_retry_at, error_message, ${hasExecutionHistory ? "COALESCE(execution_history, '[]')" : "'[]'"}, created_at, updated_at
      FROM automation_runs_old_status_check
    `);
    this.db.run("DROP TABLE automation_runs_old_status_check");
  }

  private hasColumn(table: string, column: string): boolean {
    return Boolean(this.db
      .exec(`PRAGMA table_info(${table})`)[0]
      ?.values.some((row) => row[1] === column));
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    fs.writeFileSync(this.filename, Buffer.from(this.db.export()));
  }

  private selectRows(sql: string, params?: SqlValue[]): SessionRow[] {
    const statement = this.db.prepare(sql);
    try {
      if (params) statement.bind(params);
      const rows: SessionRow[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as SessionRow);
      return rows;
    } finally {
      statement.free();
    }
  }

  private getSessionByLocalId(localSessionId: string): SessionRecord | null {
    const rows = this.selectRows("SELECT * FROM sessions WHERE local_session_id = ?", [localSessionId]);
    return rows[0] ? mapSession(rows[0]) : null;
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    if (!this.hasColumn(table, column)) this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function loadSqlJs(): Promise<SqlJsStatic> {
  return initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
  });
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: Number(row.id),
    sdkSessionId: toNullableString(row.sdk_session_id),
    agentName: toNullableString(row.agent_name) ?? "orchestrator",
    title: String(row.title),
    workspacePath: String(row.workspace_path),
    jsonlPath: toNullableString(row.jsonl_path),
    status: String(row.status) as SessionStatus,
    origin: row.origin === "automation" ? "automation" : "manual",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastOpenedAt: String(row.last_opened_at)
  };
}

function normalizeAgentName(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed || "orchestrator";
}

function mapConnectorAccount(row: SessionRow): ConnectorAccount {
  return {
    id: Number(row.id),
    platform: normalizeConnectorPlatform(String(row.platform)),
    profileKey: String(row.profile_key),
    accountId: toNullableString(row.account_id),
    accountHandle: toNullableString(row.account_handle),
    displayName: toNullableString(row.display_name),
    avatarUrl: toNullableString(row.avatar_url),
    status: normalizeConnectorStatus(String(row.status)),
    opsState: normalizeConnectorOpsState(parseJsonObject(row.ops_state)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastAuthorizedAt: toNullableString(row.last_authorized_at)
  };
}

function normalizeConnectorOpsState(value: unknown): ConnectorAccountOpsState {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rawTaskId = record.reviewTaskId ?? record.review_task_id;
  const reviewTaskId = typeof rawTaskId === "number" && Number.isInteger(rawTaskId) && rawTaskId > 0 ? rawTaskId : null;
  return { reviewTaskId };
}

function writeConnectorOpsState(value: ConnectorAccountOpsState): Record<string, unknown> {
  return {
    review_task_id: value.reviewTaskId
  };
}

function mapAutomationTask(row: SessionRow): AutomationTask {
  return {
    id: Number(row.id),
    name: String(row.name),
    description: String(row.description),
    workspacePath: String(row.workspace_path),
    scheduleType: String(row.schedule_type) as AutomationTask["scheduleType"],
    scheduleConfig: parseScheduleConfig(row.schedule_config),
    maxRetries: Number(row.max_retries ?? 0),
    maxRuns: row.max_runs === null || row.max_runs === undefined ? null : Number(row.max_runs),
    runCount: Number(row.run_count ?? 0),
    connectorBindings: parseJsonObject(row.connector_bindings) as AutomationTask["connectorBindings"],
    selectedSkills: parseJsonArray(row.selected_skills) as AutomationTask["selectedSkills"],
    attachments: parseJsonArray(row.attachments) as AutomationTask["attachments"],
    enabled: Number(row.enabled) === 1,
    nextRunAt: toNullableString(row.next_run_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function parseJsonObject(value: SqlValue): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseJsonArray(value: SqlValue): unknown[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function parseJson(value: SqlValue): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeConnectorPlatform(value: string): ConnectorPlatform {
  if (value === "xhs" || value === "wechat" || value === "douyin") return value;
  throw new Error(`Invalid connector platform: ${value}`);
}

function normalizeConnectorStatus(value: string): ConnectorAccountStatus {
  if (value === "expired") return "needs_refresh";
  if (value === "unauthorized" || value === "authorizing" || value === "authorized" || value === "needs_refresh" || value === "error") return value;
  return "error";
}

function normalizeRequiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Missing required field: ${field}`);
  return trimmed;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function mapAutomationRun(row: SessionRow): AutomationRun {
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    taskName: String(row.task_name),
    sessionId: row.session_id === null || row.session_id === undefined ? null : Number(row.session_id),
    scheduledAt: String(row.scheduled_at),
    startedAt: toNullableString(row.started_at),
    endedAt: toNullableString(row.ended_at),
    status: String(row.status) as AutomationRunStatus,
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 1),
    nextRetryAt: toNullableString(row.next_retry_at),
    errorMessage: toNullableString(row.error_message),
    executionHistory: parseAutomationRunExecutionHistory(row.execution_history),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function parseAutomationRunExecutionHistory(value: SqlValue): AutomationRunExecutionHistoryItem[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeAutomationRunHistoryItem).filter(Boolean) as AutomationRunExecutionHistoryItem[];
}

function normalizeAutomationRunHistoryItem(value: unknown): AutomationRunExecutionHistoryItem {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const status = record.status === "succeeded" || record.status === "failed" || record.status === "waiting_resource" ? record.status : "failed";
  const item: AutomationRunExecutionHistoryItem = {
    status,
    at: typeof record.at === "string" && record.at.trim() ? record.at : new Date().toISOString()
  };
  if (typeof record.sessionId === "number" && Number.isInteger(record.sessionId) && record.sessionId > 0) item.sessionId = record.sessionId;
  if (typeof record.reason === "string" && record.reason.trim()) item.reason = record.reason.trim();
  return item;
}

function parseScheduleConfig(value: SqlValue): AutomationTask["scheduleConfig"] {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const config = parsed as AutomationTask["scheduleConfig"];
    if (config.intervalValue === undefined && config.intervalMinutes !== undefined) {
      return { intervalValue: config.intervalMinutes, intervalUnit: "minute" };
    }
    return config;
  } catch {
    return {};
  }
}

function toNullableString(value: SqlValue): string | null {
  return value === null || value === undefined ? null : String(value);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

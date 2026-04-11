import Database from "better-sqlite3";
import path from "node:path";

import type {
  DriverStatus,
  NodeDetail,
  TestDefinition,
  TestLogRecord,
  TestRunRecord,
} from "../domain/types.js";
import { nowIso } from "../utils/time.js";

export interface StoredConfigRecord {
  key: string;
  value: unknown;
}

export interface ControllerSelectionRecord {
  selectedPortPath?: string;
  selectedStablePath?: string;
  lastConnectedAt?: string;
  lastStatus?: string;
}

export interface AuthSessionRecord {
  id: string;
  username: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export class DatabaseService {
  private readonly db: Database.Database;

  public constructor(dataDir: string) {
    this.db = new Database(path.join(dataDir, "app.db"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS controller_selection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        selected_port_path TEXT,
        selected_stable_path TEXT,
        last_connected_at TEXT,
        last_status TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS node_snapshots (
        node_id INTEGER PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS test_definitions (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        device_type TEXT NOT NULL,
        version INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        description TEXT NOT NULL,
        input_schema_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS test_runs (
        id TEXT PRIMARY KEY,
        test_definition_id TEXT NOT NULL,
        node_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER,
        summary_json TEXT,
        result_json TEXT
      );

      CREATE TABLE IF NOT EXISTS test_logs (
        id TEXT PRIMARY KEY,
        test_run_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        step_key TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT
      );
    `);
  }

  public close(): void {
    this.db.close();
  }

  public getConfig(): StoredConfigRecord[] {
    const rows = this.db.prepare("SELECT key, value_json FROM app_config ORDER BY key ASC").all() as {
      key: string;
      value_json: string;
    }[];

    return rows.map((row) => ({ key: row.key, value: JSON.parse(row.value_json) }));
  }

  public upsertConfig(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO app_config (key, value_json, updated_at)
         VALUES (@key, @value_json, @updated_at)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run({
        key,
        value_json: JSON.stringify(value),
        updated_at: nowIso(),
      });
  }

  public getControllerSelection(): ControllerSelectionRecord {
    const row = this.db
      .prepare(
        `SELECT selected_port_path, selected_stable_path, last_connected_at, last_status
         FROM controller_selection WHERE id = 1`,
      )
      .get() as
      | {
          selected_port_path?: string;
          selected_stable_path?: string;
          last_connected_at?: string;
          last_status?: string;
        }
      | undefined;

    return {
      selectedPortPath: row?.selected_port_path,
      selectedStablePath: row?.selected_stable_path,
      lastConnectedAt: row?.last_connected_at,
      lastStatus: row?.last_status,
    };
  }

  public saveControllerSelection(selection: ControllerSelectionRecord): void {
    this.db
      .prepare(
        `INSERT INTO controller_selection (
          id,
          selected_port_path,
          selected_stable_path,
          last_connected_at,
          last_status,
          updated_at
        ) VALUES (1, @selected_port_path, @selected_stable_path, @last_connected_at, @last_status, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          selected_port_path = excluded.selected_port_path,
          selected_stable_path = excluded.selected_stable_path,
          last_connected_at = excluded.last_connected_at,
          last_status = excluded.last_status,
          updated_at = excluded.updated_at`,
      )
      .run({
        selected_port_path: selection.selectedPortPath,
        selected_stable_path: selection.selectedStablePath,
        last_connected_at: selection.lastConnectedAt,
        last_status: selection.lastStatus,
        updated_at: nowIso(),
      });
  }

  public saveDriverStatus(status: DriverStatus): void {
    this.upsertConfig("driverStatus", status);
  }

  public upsertNodeSnapshot(node: NodeDetail): void {
    this.db
      .prepare(
        `INSERT INTO node_snapshots (node_id, snapshot_json, updated_at)
         VALUES (@node_id, @snapshot_json, @updated_at)
         ON CONFLICT(node_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`,
      )
      .run({
        node_id: node.nodeId,
        snapshot_json: JSON.stringify(node),
        updated_at: nowIso(),
      });
  }

  public removeNodeSnapshot(nodeId: number): void {
    this.db.prepare("DELETE FROM node_snapshots WHERE node_id = ?").run(nodeId);
  }

  public clearNodeSnapshots(): void {
    this.db.prepare("DELETE FROM node_snapshots").run();
  }

  public listNodeSnapshots(): NodeDetail[] {
    const rows = this.db
      .prepare("SELECT snapshot_json FROM node_snapshots ORDER BY node_id ASC")
      .all() as { snapshot_json: string }[];
    return rows.map((row) => JSON.parse(row.snapshot_json) as NodeDetail);
  }

  public getNodeSnapshot(nodeId: number): NodeDetail | undefined {
    const row = this.db
      .prepare("SELECT snapshot_json FROM node_snapshots WHERE node_id = ?")
      .get(nodeId) as { snapshot_json: string } | undefined;
    return row ? (JSON.parse(row.snapshot_json) as NodeDetail) : undefined;
  }

  public saveTestDefinitions(definitions: TestDefinition[]): void {
    const statement = this.db.prepare(
      `INSERT INTO test_definitions (
        id, key, name, device_type, version, enabled, description, input_schema_json, updated_at
      ) VALUES (
        @id, @key, @name, @device_type, @version, @enabled, @description, @input_schema_json, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        key = excluded.key,
        name = excluded.name,
        device_type = excluded.device_type,
        version = excluded.version,
        enabled = excluded.enabled,
        description = excluded.description,
        input_schema_json = excluded.input_schema_json,
        updated_at = excluded.updated_at`,
    );

    const transaction = this.db.transaction((items: TestDefinition[]) => {
      for (const item of items) {
        statement.run({
          id: item.id,
          key: item.key,
          name: item.name,
          device_type: item.deviceType,
          version: item.version,
          enabled: item.enabled ? 1 : 0,
          description: item.description,
          input_schema_json: JSON.stringify(item.inputSchema),
          updated_at: nowIso(),
        });
      }
    });

    transaction(definitions);
  }

  public listTestDefinitions(): TestDefinition[] {
    const rows = this.db
      .prepare(
        `SELECT id, key, name, device_type, version, enabled, description, input_schema_json
         FROM test_definitions ORDER BY name ASC`,
      )
      .all() as {
      id: string;
      key: string;
      name: string;
      device_type: string;
      version: number;
      enabled: number;
      description: string;
      input_schema_json: string;
    }[];

    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      deviceType: row.device_type,
      version: row.version,
      enabled: Boolean(row.enabled),
      description: row.description,
      inputSchema: JSON.parse(row.input_schema_json),
    }));
  }

  public getTestDefinition(id: string): TestDefinition | undefined {
    return this.listTestDefinitions().find((item) => item.id === id);
  }

  public createTestRun(record: TestRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO test_runs (
          id, test_definition_id, node_id, status, started_at, finished_at, duration_ms, summary_json, result_json
        ) VALUES (
          @id, @test_definition_id, @node_id, @status, @started_at, @finished_at, @duration_ms, @summary_json, @result_json
        )`,
      )
      .run({
        id: record.id,
        test_definition_id: record.testDefinitionId,
        node_id: record.nodeId,
        status: record.status,
        started_at: record.startedAt,
        finished_at: record.finishedAt,
        duration_ms: record.durationMs,
        summary_json: record.summaryJson ? JSON.stringify(record.summaryJson) : null,
        result_json: record.resultJson ? JSON.stringify(record.resultJson) : null,
      });
  }

  public updateTestRun(record: TestRunRecord): void {
    this.db
      .prepare(
        `UPDATE test_runs SET
          status = @status,
          started_at = @started_at,
          finished_at = @finished_at,
          duration_ms = @duration_ms,
          summary_json = @summary_json,
          result_json = @result_json
        WHERE id = @id`,
      )
      .run({
        id: record.id,
        status: record.status,
        started_at: record.startedAt,
        finished_at: record.finishedAt,
        duration_ms: record.durationMs,
        summary_json: record.summaryJson ? JSON.stringify(record.summaryJson) : null,
        result_json: record.resultJson ? JSON.stringify(record.resultJson) : null,
      });
  }

  public listTestRuns(): TestRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, test_definition_id, node_id, status, started_at, finished_at, duration_ms, summary_json, result_json
         FROM test_runs ORDER BY COALESCE(started_at, finished_at, id) DESC`,
      )
      .all() as {
      id: string;
      test_definition_id: string;
      node_id: number;
      status: TestRunRecord["status"];
      started_at?: string;
      finished_at?: string;
      duration_ms?: number;
      summary_json?: string;
      result_json?: string;
    }[];

    return rows.map((row) => ({
      id: row.id,
      testDefinitionId: row.test_definition_id,
      nodeId: row.node_id,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      summaryJson: row.summary_json ? JSON.parse(row.summary_json) : undefined,
      resultJson: row.result_json ? JSON.parse(row.result_json) : undefined,
    }));
  }

  public getTestRun(id: string): TestRunRecord | undefined {
    return this.listTestRuns().find((item) => item.id === id);
  }

  public appendTestLog(log: TestLogRecord): void {
    this.db
      .prepare(
        `INSERT INTO test_logs (id, test_run_id, timestamp, level, step_key, message, payload_json)
         VALUES (@id, @test_run_id, @timestamp, @level, @step_key, @message, @payload_json)`,
      )
      .run({
        id: log.id,
        test_run_id: log.testRunId,
        timestamp: log.timestamp,
        level: log.level,
        step_key: log.stepKey,
        message: log.message,
        payload_json: log.payloadJson ? JSON.stringify(log.payloadJson) : null,
      });
  }

  public listTestLogs(testRunId: string): TestLogRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, test_run_id, timestamp, level, step_key, message, payload_json
         FROM test_logs WHERE test_run_id = ? ORDER BY timestamp ASC`,
      )
      .all(testRunId) as {
      id: string;
      test_run_id: string;
      timestamp: string;
      level: TestLogRecord["level"];
      step_key: string;
      message: string;
      payload_json?: string;
    }[];

    return rows.map((row) => ({
      id: row.id,
      testRunId: row.test_run_id,
      timestamp: row.timestamp,
      level: row.level,
      stepKey: row.step_key,
      message: row.message,
      payloadJson: row.payload_json ? JSON.parse(row.payload_json) : undefined,
    }));
  }

  public createAuthSession(record: AuthSessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO auth_sessions (id, username, token_hash, created_at, expires_at, last_seen_at, revoked_at)
         VALUES (@id, @username, @token_hash, @created_at, @expires_at, @last_seen_at, @revoked_at)`,
      )
      .run({
        id: record.id,
        username: record.username,
        token_hash: record.tokenHash,
        created_at: record.createdAt,
        expires_at: record.expiresAt,
        last_seen_at: record.lastSeenAt,
        revoked_at: record.revokedAt ?? null,
      });
  }

  public getAuthSessionByTokenHash(tokenHash: string): AuthSessionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, username, token_hash, created_at, expires_at, last_seen_at, revoked_at
         FROM auth_sessions WHERE token_hash = ?`,
      )
      .get(tokenHash) as
      | {
          id: string;
          username: string;
          token_hash: string;
          created_at: string;
          expires_at: string;
          last_seen_at: string;
          revoked_at?: string;
        }
      | undefined;

    return row
      ? {
          id: row.id,
          username: row.username,
          tokenHash: row.token_hash,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          lastSeenAt: row.last_seen_at,
          revokedAt: row.revoked_at,
        }
      : undefined;
  }

  public touchAuthSession(id: string, lastSeenAt: string): void {
    this.db
      .prepare(`UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?`)
      .run(lastSeenAt, id);
  }

  public revokeAuthSession(id: string, revokedAt: string): void {
    this.db
      .prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE id = ?`)
      .run(revokedAt, id);
  }

  public revokeAllExpiredSessions(now: string): void {
    this.db
      .prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE expires_at <= ? AND revoked_at IS NULL`)
      .run(now, now);
  }
}

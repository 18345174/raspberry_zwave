<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { apiClient } from "../api/client";
import { usePlatformStore } from "../stores/platform";
import type { NodeSummary, TestDefinition, TestLogRecord, TestRunRecord } from "../types";
import { downloadTextFile, downloadXlsxFromCsv } from "../utils/report-files";
import { translateRunStatus } from "../utils/ui-text";

type TestPageStage = "devices" | "definitions" | "execution";
type ExecutionStatus = TestRunRecord["status"] | "pending";
type StepState = "pending" | "running" | "passed" | "failed" | "warn";

interface ExecutionItem {
  definition: TestDefinition;
  runId?: string;
  status: ExecutionStatus;
  expanded: boolean;
}

interface DeviceSupportRecord {
  node: NodeSummary;
  definitions: TestDefinition[];
}

interface ManualUnlockPrompt {
  runId: string;
  promptKey: string;
  promptTitle: string;
  promptMessage: string;
  promptMeta: string;
  canSkip: boolean;
  skipButtonLabel?: string;
}

interface AggregatedStepRecord extends TestLogRecord {
  payloadJson?: Record<string, unknown> & {
    aggregatedKind?: string;
    aggregatedStage?: string;
  };
}

const TERMINAL_STATUSES = new Set<TestRunRecord["status"]>(["passed", "failed", "cancelled"]);

const platform = usePlatformStore();

const pageStage = ref<TestPageStage>("devices");
const selectedNodeId = ref<number | null>(null);
const selectedDefinitionIds = ref<string[]>([]);
const supportedDefinitionMap = ref<Record<number, TestDefinition[]>>({});
const loadingDeviceMatrix = ref(false);
const executionItems = ref<ExecutionItem[]>([]);
const executionBusy = ref(false);
const executionError = ref("");
const manualPromptActionBusy = ref(false);
const currentExecutionRunId = ref("");
const executionToken = ref(0);
const reportActionBusy = ref(false);
const reportStatusMessage = ref("");
let supportLoadToken = 0;

const TEST_DEFINITION_PRIORITY: Record<string, number> = {
  "user-code-add": 0,
  "user-code-edit": 1,
  "user-code-delete": 2,
};
const USER_CODE_ADD_KEY = "user-code-add";
const USER_CODE_DEPENDENT_KEYS = new Set(["user-code-edit", "user-code-delete"]);
const MANUAL_UNLOCK_LOG_STEP_KEYS = new Set(["manual.start", "manual.wait", "manual.confirmed", "manual.done"]);
const HIDDEN_LOG_STEP_KEYS = new Set(["add.fallback", "edit.fallback", "delete.fallback", "precheck.capabilities"]);
const CONFIGURATION_PARAMETER_STEP_KEY_RE = /^parameter\.(\d+)\.(start|write\.set|write\.verify|write\.fallback|restore\.set|restore\.verify|result)$/;
const controllerReady = computed(() => platform.status.hasReadyDriver && platform.status.phase === "ready");

const runnableNodes = computed(() => {
  if (!controllerReady.value) {
    return [];
  }
  return [...platform.nodes]
    .filter((node) => node.nodeId !== platform.status.controllerId && node.deviceType !== "Controller")
    .sort((left, right) => left.nodeId - right.nodeId);
});

const selectedNode = computed(() => {
  return runnableNodes.value.find((node) => node.nodeId === selectedNodeId.value) ?? null;
});

const selectedNodeDefinitions = computed(() => {
  if (!selectedNodeId.value) {
    return [];
  }
  return sortDefinitions(supportedDefinitionMap.value[selectedNodeId.value] ?? []);
});

const selectedDefinitions = computed(() => {
  return selectedNodeDefinitions.value.filter((definition) => selectedDefinitionIds.value.includes(definition.id));
});

const hasBlockingRun = computed(() => {
  return platform.runs.some((run) => run.status === "queued" || run.status === "running");
});

const testableDevices = computed<DeviceSupportRecord[]>(() => {
  return runnableNodes.value
    .map((node) => ({
      node,
      definitions: supportedDefinitionMap.value[node.nodeId] ?? [],
    }))
    .filter((item) => item.definitions.length > 0);
});

const completedExecutionCount = computed(() => {
  return executionItems.value.filter((item) => TERMINAL_STATUSES.has(getExecutionItemStatus(item) as TestRunRecord["status"])).length;
});

const passedExecutionCount = computed(() => {
  return executionItems.value.filter((item) => getExecutionItemStatus(item) === "passed").length;
});

const canExportExecutionReport = computed(() => {
  if (pageStage.value !== "execution" || executionBusy.value || reportActionBusy.value) {
    return false;
  }

  return executionItems.value.some((item) => item.runId || item.status !== "pending");
});

const progressPercent = computed(() => {
  if (!executionItems.value.length) {
    return 0;
  }
  return Math.round((completedExecutionCount.value / executionItems.value.length) * 100);
});

const overallExecutionStatus = computed<ExecutionStatus>(() => {
  if (!executionItems.value.length) {
    return "pending";
  }
  if (executionBusy.value || executionItems.value.some((item) => {
    const status = getExecutionItemStatus(item);
    return status === "queued" || status === "running";
  })) {
    return "running";
  }
  if (executionItems.value.some((item) => getExecutionItemStatus(item) === "failed")) {
    return "failed";
  }
  if (executionItems.value.some((item) => getExecutionItemStatus(item) === "cancelled")) {
    return "cancelled";
  }
  if (executionItems.value.every((item) => getExecutionItemStatus(item) === "passed")) {
    return "passed";
  }
  return "pending";
});

const activeManualUnlockPrompt = computed<ManualUnlockPrompt | null>(() => {
  const activeItem = executionItems.value.find((item) => {
    const status = getExecutionItemStatus(item);
    return status === "running" || status === "queued";
  });

  if (!activeItem?.runId) {
    return null;
  }

  const logs = platform.runLogs[activeItem.runId] ?? [];
  let latestPrompt: TestLogRecord | null = null;
  let latestDoneTimestamp = 0;

  for (const log of logs) {
    if (log.stepKey === "manual.wait") {
      latestPrompt = log;
    } else if (log.stepKey === "manual.done") {
      latestDoneTimestamp = Date.parse(log.timestamp);
    }
  }

  if (!latestPrompt) {
    return null;
  }

  if (latestDoneTimestamp >= Date.parse(latestPrompt.timestamp)) {
    return null;
  }

  const payload = latestPrompt.payloadJson ?? {};
  const promptKey = typeof payload.promptKey === "string" && payload.promptKey.trim().length
    ? payload.promptKey.trim()
    : latestPrompt.id;
  const promptTitle = typeof payload.promptTitle === "string" && payload.promptTitle.trim().length
    ? payload.promptTitle.trim()
    : activeItem.definition.name;
  const promptMessage = typeof payload.promptMessage === "string" && payload.promptMessage.trim().length
    ? payload.promptMessage
    : Number.isInteger(Number(payload.userId)) && Number(payload.userId) > 0
      ? `请使用 User ID：${Number(payload.userId)} 的 User Code 在设备上手动解锁`
      : "";
  const promptMeta = typeof payload.promptMeta === "string" && payload.promptMeta.trim().length
    ? payload.promptMeta
    : Number.isInteger(Number(payload.sequence)) && Number(payload.sequence) > 0 && Number.isInteger(Number(payload.totalCount)) && Number(payload.totalCount) > 0
      ? `第 ${Number(payload.sequence)} / ${Number(payload.totalCount)} 组，检测到预期上报后会自动进入下一组。`
      : "";

  if (!promptMessage || !promptKey) {
    return null;
  }

  return {
    runId: activeItem.runId,
    promptKey,
    promptTitle,
    promptMessage,
    promptMeta,
    canSkip: payload.canSkip === true,
    skipButtonLabel: typeof payload.skipButtonLabel === "string" ? payload.skipButtonLabel : undefined,
  };
});

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll("\"", "\"\"")}"`;
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function describeNode(node: NodeSummary): string {
  return node.product || node.name || node.manufacturer || `节点 ${node.nodeId}`;
}

function getDefinitionPriority(definition: TestDefinition): number {
  return TEST_DEFINITION_PRIORITY[definition.key] ?? 100;
}

function requiresUserCodeAdd(definition: TestDefinition): boolean {
  return USER_CODE_DEPENDENT_KEYS.has(definition.key);
}

function isDefinitionSelectable(definition: TestDefinition): boolean {
  if (!requiresUserCodeAdd(definition)) {
    return true;
  }
  return selectedDefinitionIds.value.includes(selectedNodeDefinitions.value.find((item) => item.key === USER_CODE_ADD_KEY)?.id ?? "");
}

function normalizeSelectedDefinitionIds(ids: string[]): string[] {
  const selectedDefinitionsById = new Map(selectedNodeDefinitions.value.map((definition) => [definition.id, definition]));
  const addDefinition = selectedNodeDefinitions.value.find((definition) => definition.key === USER_CODE_ADD_KEY);
  const hasUserCodeAdd = addDefinition ? ids.includes(addDefinition.id) : false;

  return ids.filter((id) => {
    const definition = selectedDefinitionsById.get(id);
    if (!definition) {
      return false;
    }
    if (!requiresUserCodeAdd(definition)) {
      return true;
    }
    return hasUserCodeAdd;
  });
}

function sortDefinitions(definitions: TestDefinition[]): TestDefinition[] {
  return [...definitions].sort((left, right) => {
    const priorityDiff = getDefinitionPriority(left) - getDefinitionPriority(right);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return left.name.localeCompare(right.name, "zh-CN");
  });
}

function formatDefinitionList(definitions: TestDefinition[]): string {
  return sortDefinitions(definitions).map((definition) => definition.name).join(" / ");
}

function formatTimestamp(value?: string): string {
  if (!value) {
    return "-";
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Date(timestamp).toLocaleString();
}

function formatDuration(durationMs?: number): string {
  if (typeof durationMs !== "number" || Number.isNaN(durationMs) || durationMs < 0) {
    return "-";
  }

  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }

  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainSeconds = Math.round(seconds % 60);
  return `${minutes} 分 ${remainSeconds} 秒`;
}

function formatLogPayload(log: TestLogRecord): string {
  return log.payloadJson ? JSON.stringify(log.payloadJson, null, 2) : "";
}

function shouldShowLogPayload(log: TestLogRecord): boolean {
  void log;
  return false;
}

function translateExecutionStatus(status: ExecutionStatus): string {
  if (status === "pending") {
    return "待执行";
  }
  return translateRunStatus(status);
}

function getExecutionItemStatus(item: ExecutionItem): ExecutionStatus {
  if (!item.runId) {
    return item.status;
  }
  const liveRun = platform.runs.find((run) => run.id === item.runId);
  return liveRun?.status ?? item.status;
}

function getExecutionRun(item: ExecutionItem): TestRunRecord | undefined {
  if (!item.runId) {
    return undefined;
  }
  return platform.runs.find((run) => run.id === item.runId);
}

function getExecutionLogs(item: ExecutionItem): TestLogRecord[] {
  if (!item.runId) {
    return [];
  }
  const sourceLogs = platform.runLogs[item.runId] ?? [];
  const hasManualUnlockFlow = sourceLogs.some((log) => MANUAL_UNLOCK_LOG_STEP_KEYS.has(log.stepKey));
  const logs = sourceLogs.filter((log) => !HIDDEN_LOG_STEP_KEYS.has(log.stepKey) && !MANUAL_UNLOCK_LOG_STEP_KEYS.has(log.stepKey));
  const collapsedLogs: AggregatedStepRecord[] = [];
  const progressLogIndexes = new Map<string, number>();
  const configurationLogIndexes = new Map<number, number>();

  for (const log of logs) {
    const configurationMatch = log.stepKey.match(CONFIGURATION_PARAMETER_STEP_KEY_RE);
    if (configurationMatch) {
      const parameter = Number(configurationMatch[1]);
      const stage = configurationMatch[2];
      const existingIndex = configurationLogIndexes.get(parameter);
      const label = getConfigurationParameterLabel(log, parameter);
      const aggregatedLog: AggregatedStepRecord = {
        ...log,
        stepKey: "configuration.parameter.summary",
        message: getConfigurationStageMessage(label, stage, log),
        payloadJson: {
          ...(log.payloadJson ?? {}),
          aggregatedKind: "configuration-parameter",
          aggregatedStage: stage,
          parameter,
          label,
        },
      };

      if (existingIndex == undefined) {
        configurationLogIndexes.set(parameter, collapsedLogs.length);
        collapsedLogs.push(aggregatedLog);
      } else {
        collapsedLogs[existingIndex] = aggregatedLog;
      }
      continue;
    }

    if (!log.stepKey.endsWith(".progress")) {
      collapsedLogs.push(log);
      continue;
    }

    const existingIndex = progressLogIndexes.get(log.stepKey);
    if (existingIndex == undefined) {
      progressLogIndexes.set(log.stepKey, collapsedLogs.length);
      collapsedLogs.push(log);
      continue;
    }

    collapsedLogs[existingIndex] = log;
  }

  if (hasManualUnlockFlow) {
    const latestManualLog = [...sourceLogs].reverse().find((log) => MANUAL_UNLOCK_LOG_STEP_KEYS.has(log.stepKey));
    collapsedLogs.push({
      id: `${item.runId}-manual-summary`,
      testRunId: item.runId,
      timestamp: latestManualLog?.timestamp ?? new Date().toISOString(),
      level: "info",
      stepKey: "manual.summary",
      message: latestManualLog?.message ?? "等待人工交互步骤",
    });
  }

  return collapsedLogs;
}

function getLogStepState(item: ExecutionItem, index: number, logs: TestLogRecord[]): StepState {
  const log = logs[index];
  const status = getExecutionItemStatus(item);

  if (log?.level === "error") {
    return "failed";
  }

  if (log?.level === "warn") {
    return "warn";
  }

  if (log?.stepKey === "configuration.parameter.summary") {
    const stage = typeof log.payloadJson?.aggregatedStage === "string" ? log.payloadJson.aggregatedStage : "";
    if (status === "failed" || status === "cancelled") {
      return stage === "result" ? "passed" : "failed";
    }
    if (status === "running" || status === "queued") {
      return stage === "result" ? "passed" : "running";
    }
    return stage === "result" ? "passed" : "pending";
  }

  if (log?.stepKey === "manual.summary") {
    if (status === "failed" || status === "cancelled") {
      return "failed";
    }
    if (status === "running" || status === "queued") {
      return "running";
    }
    if (status === "passed") {
      return "passed";
    }
  }

  if (log?.stepKey === "add.progress") {
    if (status === "running" || status === "queued") {
      return "running";
    }
  }

  if (index === logs.length - 1 && (status === "failed" || status === "cancelled")) {
    return "failed";
  }

  if (index === logs.length - 1) {
    if (status === "running" || status === "queued") {
      return "running";
    }
  }
  return "passed";
}

function getConfigurationParameterLabel(log: TestLogRecord, parameter: number): string {
  const payloadName = typeof log.payloadJson?.parameterName === "string" ? log.payloadJson.parameterName.trim() : "";
  const payloadInfo = typeof log.payloadJson?.parameterInfo === "string" ? log.payloadJson.parameterInfo.trim() : "";
  const label = payloadName || payloadInfo;
  return label ? `Configuration 参数 ${parameter}（${label}）` : `Configuration 参数 ${parameter}`;
}

function getConfigurationStageMessage(label: string, stage: string, log: TestLogRecord): string {
  const from = typeof log.payloadJson?.from === "number" ? log.payloadJson.from : undefined;
  const to = typeof log.payloadJson?.to === "number" ? log.payloadJson.to : undefined;
  const expectedValue = typeof log.payloadJson?.expectedValue === "number" ? log.payloadJson.expectedValue : undefined;
  const readBack = typeof log.payloadJson?.readBack === "number" ? log.payloadJson.readBack : undefined;
  const retryTargetValue = typeof log.payloadJson?.retryTargetValue === "number" ? log.payloadJson.retryTargetValue : undefined;

  if (stage === "result") {
    return `${label} 测试通过`;
  }
  if (stage.startsWith("write")) {
    if (stage === "write.fallback" && retryTargetValue != undefined) {
      return `${label} 写入最大值失败，改为写入 ${retryTargetValue}`;
    }
    if (stage === "write.set" && from != undefined && to != undefined) {
      return `${label} 写入测试值（${from} -> ${to}）`;
    }
    if (stage === "write.verify" && expectedValue != undefined && readBack != undefined) {
      return `${label} 写入校验（期望 ${expectedValue}，实际 ${readBack}）`;
    }
    return `${label} 写入测试值`;
  }
  if (stage.startsWith("restore")) {
    if (stage === "restore.set" && from != undefined && to != undefined) {
      return `${label} 恢复原值（${from} -> ${to}）`;
    }
    if (stage === "restore.verify" && expectedValue != undefined && readBack != undefined) {
      return `${label} 恢复校验（期望 ${expectedValue}，实际 ${readBack}）`;
    }
    return `${label} 恢复原值`;
  }
  return `开始测试 ${label}`;
}

function getPlaceholderStepState(item: ExecutionItem): StepState {
  const status = getExecutionItemStatus(item);
  if (status === "failed" || status === "cancelled") {
    return "failed";
  }
  if (status === "running" || status === "queued") {
    return "running";
  }
  return "pending";
}

function getPlaceholderStepMessage(item: ExecutionItem): string {
  const status = getExecutionItemStatus(item);
  if (status === "pending") {
    return "等待开始执行";
  }
  if (status === "queued") {
    return "任务已创建，等待后端开始执行";
  }
  if (status === "running") {
    return "正在执行，请稍候...";
  }
  if (status === "cancelled") {
    return "测试已取消";
  }
  if (status === "failed") {
    return "测试失败，等待日志同步";
  }
  return "测试完成";
}

function buildExecutionReportSummaryPayload(): Record<string, unknown> {
  return {
    nodeId: selectedNode.value?.nodeId,
    nodeName: selectedNode.value ? describeNode(selectedNode.value) : undefined,
    deviceType: selectedNode.value?.deviceType,
    manufacturer: selectedNode.value?.manufacturer,
    overallStatus: overallExecutionStatus.value,
    overallStatusLabel: translateExecutionStatus(overallExecutionStatus.value),
    totalCount: executionItems.value.length,
    completedCount: completedExecutionCount.value,
    passedCount: passedExecutionCount.value,
    generatedAt: new Date().toISOString(),
  };
}

function buildExecutionReportBaseName(reportId?: string): string {
  const nodePart = selectedNode.value ? `node-${selectedNode.value.nodeId}` : "node-unknown";
  const timePart = new Date().toISOString().replaceAll(":", "-");
  return reportId
    ? `zwave-test-report-${nodePart}-${reportId}`
    : `zwave-test-report-${nodePart}-${timePart}`;
}

function getReportFailureLogs(item: ExecutionItem): TestLogRecord[] {
  const status = getExecutionItemStatus(item);
  if (status !== "failed" && status !== "cancelled") {
    return [];
  }

  const logs = getExecutionLogs(item);
  if (logs.length) {
    return logs;
  }

  return [{
    id: `${item.runId ?? item.definition.id}-report-failure`,
    testRunId: item.runId ?? "",
    timestamp: new Date().toISOString(),
    level: "error",
    stepKey: "report.failure",
    message: getPlaceholderStepMessage(item),
  }];
}

function getReportFailureStep(item: ExecutionItem): string {
  const failureLogs = getReportFailureLogs(item);
  return failureLogs.find((log) => log.level === "error")?.message
    ?? failureLogs.at(-1)?.message
    ?? "-";
}

function formatReportFailureLogs(logs: TestLogRecord[]): string {
  return logs.map((log) => {
    const payload = log.payloadJson ? ` ${JSON.stringify(log.payloadJson)}` : "";
    return `[${formatTimestamp(log.timestamp)}] ${log.level.toUpperCase()} ${log.message}${payload}`;
  }).join("\n");
}

function getReportStatusTone(status: ExecutionStatus): "passed" | "failed" | "cancelled" | "running" | "pending" {
  if (status === "passed") {
    return "passed";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "running" || status === "queued") {
    return "running";
  }
  return "pending";
}

function buildExecutionReportHtml(): string {
  const reportGeneratedAt = new Date().toLocaleString();
  const overallStatusText = translateExecutionStatus(overallExecutionStatus.value);
  const deviceSummary = [
    ["节点 ID", selectedNode.value ? String(selectedNode.value.nodeId) : "-"],
    ["设备名称", selectedNode.value ? describeNode(selectedNode.value) : "-"],
    ["设备类型", selectedNode.value?.deviceType || "未识别"],
    ["制造商", selectedNode.value?.manufacturer || "-"],
    ["产品名称", selectedNode.value?.product || "-"],
  ];
  const environmentSummary = [
    ["报告生成时间", reportGeneratedAt],
    ["总体状态", overallStatusText],
    ["Controller 状态", platform.status.phase],
    ["Controller ID", platform.status.controllerId != undefined ? String(platform.status.controllerId) : "-"],
    ["Home ID", platform.status.homeId || "-"],
    ["连接端口", platform.status.connectedPortPath || platform.status.selectedPortPath || "-"],
    ["测试项总数", String(executionItems.value.length)],
    ["已完成", String(completedExecutionCount.value)],
    ["已通过", String(passedExecutionCount.value)],
  ];

  const buildSummaryRows = (rows: string[][]) => rows.map(([label, value]) => `
      <tr>
        <th>${escapeHtml(label)}</th>
        <td>${escapeHtml(value)}</td>
      </tr>`).join("");

  const overviewCards = [
    ["总体状态", overallStatusText, getReportStatusTone(overallExecutionStatus.value)],
    ["测试项总数", String(executionItems.value.length), "pending"],
    ["已完成", String(completedExecutionCount.value), "running"],
    ["已通过", String(passedExecutionCount.value), "passed"],
  ] as const;

  const overviewCardMarkup = overviewCards.map(([label, value, tone]) => `
      <article class="overview-card" data-tone="${tone}">
        <span class="overview-label">${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </article>
  `).join("");

  const resultRows = executionItems.value.map((item, index) => {
    const status = getExecutionItemStatus(item);
    const tone = getReportStatusTone(status);
    return `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(item.definition.name)}</td>
        <td>
          <span class="status-badge" data-tone="${tone}">
            ${escapeHtml(translateExecutionStatus(status))}
          </span>
        </td>
      </tr>`;
  }).join("");

  const failureSections = executionItems.value.map((item, index) => {
    const run = getExecutionRun(item);
    const itemStatus = getExecutionItemStatus(item);
    const failureLogs = getReportFailureLogs(item);
    if (!failureLogs.length) {
      return "";
    }

    return `
      <section class="failure-card">
        <div class="failure-card-header">
          <div>
            <h3>${index + 1}. ${escapeHtml(item.definition.name)}</h3>
            <p class="meta-line">结果：${escapeHtml(translateExecutionStatus(itemStatus))}</p>
          </div>
          <div class="meta-grid">
            <span>任务 ID：${escapeHtml(item.runId || "-")}</span>
            <span>开始时间：${escapeHtml(formatTimestamp(run?.startedAt))}</span>
            <span>结束时间：${escapeHtml(formatTimestamp(run?.finishedAt))}</span>
            <span>耗时：${escapeHtml(formatDuration(run?.durationMs))}</span>
          </div>
        </div>
        <div class="failure-detail-grid">
          <div>
            <strong>失败步骤</strong>
            <p>${escapeHtml(getReportFailureStep(item))}</p>
          </div>
          <div>
            <strong>相关日志</strong>
            <pre>${escapeHtml(formatReportFailureLogs(failureLogs))}</pre>
          </div>
        </div>
      </section>`;
  }).filter(Boolean).join("");

  const errorSection = executionError.value
    ? `<section class="notice-card error-card"><strong>错误信息：</strong>${escapeHtml(executionError.value)}</section>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Z-Wave 测试报告</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #222b45;
      --muted: #7a839a;
      --line: #e7ebf3;
      --paper: #f7f9fc;
      --card: #ffffff;
      --accent: #5a6acf;
      --accent-soft: #eef2ff;
      --good: #1f9d68;
      --good-soft: #e8f8f0;
      --bad: #de4b4b;
      --bad-soft: #fff0f0;
      --warn: #ffb020;
      --warn-soft: #fff6df;
      --idle: #8f9bb3;
      --idle-soft: #f1f4f9;
      --shadow: 0 12px 30px rgba(31, 45, 61, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px;
      background:
        radial-gradient(circle at top left, rgba(90, 106, 207, 0.10), transparent 28%),
        linear-gradient(180deg, #f7f9fc 0%, #eef2f7 100%);
      color: var(--ink);
      font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .report-shell {
      max-width: 1180px;
      margin: 0 auto;
      display: grid;
      gap: 24px;
    }
    .hero, .summary-card, .test-card, .notice-card, .failure-card {
      background: rgba(255, 255, 255, 0.94);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: var(--shadow);
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 20px;
    }
    .hero, .summary-card, .notice-card, .test-card, .failure-card {
      padding: 24px;
    }
    .hero {
      padding: 28px;
    }
    .hero-kicker,
    .section-kicker-report {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 0 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .hero h1, .test-card h2, .failure-card h3, .summary-card h2 { margin: 0; }
    .hero h1 {
      margin-top: 12px;
      font-size: 32px;
      line-height: 1.2;
    }
    .hero p, .meta-line { margin: 8px 0 0; color: var(--muted); }
    .hero p {
      max-width: 720px;
      font-size: 15px;
    }
    .overview-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 20px;
    }
    .overview-card {
      display: grid;
      gap: 8px;
      padding: 16px 18px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: var(--paper);
    }
    .overview-card strong {
      font-size: 24px;
      line-height: 1.1;
    }
    .overview-label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .overview-card[data-tone="passed"] {
      background: var(--good-soft);
      border-color: rgba(31, 157, 104, 0.18);
    }
    .overview-card[data-tone="failed"],
    .overview-card[data-tone="cancelled"] {
      background: var(--bad-soft);
      border-color: rgba(222, 75, 75, 0.18);
    }
    .overview-card[data-tone="running"] {
      background: var(--warn-soft);
      border-color: rgba(255, 176, 32, 0.18);
    }
    .summary-table {
      width: 100%;
      border-collapse: collapse;
    }
    .summary-card h2,
    .test-card h2 {
      margin-bottom: 14px;
      font-size: 18px;
    }
    .summary-table th, .summary-table td {
      padding: 11px 0;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    .summary-table th {
      width: 160px;
      color: var(--muted);
      font-weight: 700;
    }
    .meta-grid {
      display: grid;
      gap: 4px;
      color: var(--muted);
      text-align: right;
      white-space: nowrap;
    }
    .result-table {
      width: 100%;
      border-collapse: collapse;
      overflow: hidden;
    }
    .result-table th, .result-table td {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    .result-table thead {
      background: linear-gradient(180deg, #f8faff 0%, #f3f6fb 100%);
    }
    .result-table th {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .result-table tbody tr:hover {
      background: rgba(90, 106, 207, 0.04);
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 0 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    .status-badge[data-tone="passed"] {
      color: var(--good);
      background: var(--good-soft);
    }
    .status-badge[data-tone="failed"],
    .status-badge[data-tone="cancelled"] {
      color: var(--bad);
      background: var(--bad-soft);
    }
    .status-badge[data-tone="running"] {
      color: #9a6a00;
      background: var(--warn-soft);
    }
    .status-badge[data-tone="pending"] {
      color: var(--idle);
      background: var(--idle-soft);
    }
    .failure-card {
      display: grid;
      gap: 18px;
      border: 1px solid rgba(175, 63, 49, 0.18);
      background: linear-gradient(180deg, #fff8f8 0%, #fffdfd 100%);
    }
    .failure-card-header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: start;
      padding-bottom: 14px;
      border-bottom: 1px solid rgba(222, 75, 75, 0.12);
    }
    .failure-detail-grid {
      display: grid;
      gap: 16px;
    }
    .failure-card p, .failure-card strong {
      margin: 0;
    }
    .failure-detail-grid strong {
      display: block;
      margin-bottom: 8px;
      color: var(--ink);
    }
    .failure-card pre {
      margin: 0;
      padding: 14px;
      overflow: auto;
      border-radius: 12px;
      background: #261f33;
      color: #f8f4ff;
      white-space: pre-wrap;
      word-break: break-word;
      font: 12px/1.6 "SFMono-Regular", "Consolas", monospace;
    }
    .error-card {
      border-color: rgba(175, 63, 49, 0.24);
      color: var(--bad);
    }
    @media (max-width: 768px) {
      body { padding: 16px; }
      .summary-grid,
      .overview-strip {
        grid-template-columns: 1fr;
      }
      .failure-card-header {
        grid-template-columns: 1fr;
        display: grid;
      }
      .meta-grid { text-align: left; white-space: normal; }
      .summary-table th { width: 120px; }
    }
  </style>
</head>
<body>
  <main class="report-shell">
    <section class="hero">
      <span class="hero-kicker">Overview</span>
      <h1>Z-Wave 自动化测试报告</h1>
      <p>该报告由测试中心一键导出，顶部展示测试设备与环境信息，下方展示测试项结果列表；如存在失败项，会在末尾附带失败步骤和相关日志。</p>
      <div class="overview-strip">${overviewCardMarkup}
      </div>
    </section>

    <div class="summary-grid">
      <section class="summary-card">
        <span class="section-kicker-report">Device</span>
        <h2>测试设备信息</h2>
        <table class="summary-table">
          <tbody>${buildSummaryRows(deviceSummary)}
          </tbody>
        </table>
      </section>

      <section class="summary-card">
        <span class="section-kicker-report">Environment</span>
        <h2>环境信息</h2>
        <table class="summary-table">
          <tbody>${buildSummaryRows(environmentSummary)}
          </tbody>
        </table>
      </section>
    </div>

    ${errorSection}
    <section class="test-card">
      <h2>测试项列表</h2>
      <table class="result-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>测试项目名称</th>
            <th>测试结果</th>
          </tr>
        </thead>
        <tbody>${resultRows}
        </tbody>
      </table>
    </section>
    ${failureSections}
  </main>
</body>
</html>`;
}

function buildExecutionReportCsv(): string {
  const lines = [
    ["报告类型", "Z-Wave 自动化测试报告"],
    ["报告生成时间", formatTimestamp(new Date().toISOString())],
    ["测试节点", selectedNode.value ? `#${selectedNode.value.nodeId} ${describeNode(selectedNode.value)}` : "-"],
    ["设备类型", selectedNode.value?.deviceType || "未识别"],
    ["制造商", selectedNode.value?.manufacturer || "-"],
    ["产品名称", selectedNode.value?.product || "-"],
    ["总体状态", translateExecutionStatus(overallExecutionStatus.value)],
    ["Controller 状态", platform.status.phase],
    ["Controller ID", platform.status.controllerId != undefined ? String(platform.status.controllerId) : "-"],
    ["Home ID", platform.status.homeId || "-"],
    ["连接端口", platform.status.connectedPortPath || platform.status.selectedPortPath || "-"],
    ["测试项总数", String(executionItems.value.length)],
    ["已完成", String(completedExecutionCount.value)],
    ["已通过", String(passedExecutionCount.value)],
    [],
    ["ID", "测试项目名称", "测试结果"],
  ];

  executionItems.value.forEach((item, index) => {
    lines.push([
      String(index + 1),
      item.definition.name,
      translateExecutionStatus(getExecutionItemStatus(item)),
    ]);
  });

  const failedItems = executionItems.value.filter((item) => getReportFailureLogs(item).length > 0);
  if (failedItems.length) {
    lines.push([]);
    lines.push(["失败详情"]);
    lines.push(["ID", "测试项目名称", "任务 ID", "开始时间", "结束时间", "耗时", "失败步骤", "失败日志"]);
  }

  failedItems.forEach((item, index) => {
    const run = getExecutionRun(item);
    const failureLogs = getReportFailureLogs(item);
    lines.push([
      String(executionItems.value.indexOf(item) + 1),
      item.definition.name,
      item.runId || "-",
      formatTimestamp(run?.startedAt),
      formatTimestamp(run?.finishedAt),
      formatDuration(run?.durationMs),
      failureLogs.length ? getReportFailureStep(item) : "",
      failureLogs.length ? formatReportFailureLogs(failureLogs) : "",
    ]);
  });

  return lines
    .map((row) => row.map((cell) => escapeCsvField(String(cell ?? ""))).join(","))
    .join("\n");
}

async function generateAndSaveExecutionReport(): Promise<void> {
  if (!selectedNode.value || !canExportExecutionReport.value) {
    return;
  }

  reportActionBusy.value = true;
  reportStatusMessage.value = "";

  try {
    const htmlContent = buildExecutionReportHtml();
    const csvContent = buildExecutionReportCsv();
    const createdReport = await apiClient.createReport({
      nodeId: selectedNode.value.nodeId,
      title: `${describeNode(selectedNode.value)} 测试报告`,
      status: translateExecutionStatus(overallExecutionStatus.value),
      sourceRunIds: executionItems.value.map((item) => item.runId).filter((value): value is string => Boolean(value)),
      summaryJson: buildExecutionReportSummaryPayload(),
      htmlContent,
      csvContent,
    });

    const baseName = buildExecutionReportBaseName(createdReport.id);
    downloadTextFile(htmlContent, `${baseName}.html`, "text/html;charset=utf-8");
    await downloadXlsxFromCsv(csvContent, `${baseName}.xlsx`, "Test Report");

    reportStatusMessage.value = `测试报告已生成，并已保存到历史记录（报告 ID：${createdReport.id}）。`;
  } catch (error) {
    reportStatusMessage.value = getErrorMessage(error);
  } finally {
    reportActionBusy.value = false;
  }
}

function toggleDefinition(definitionId: string): void {
  const definition = selectedNodeDefinitions.value.find((item) => item.id === definitionId);
  if (!definition) {
    return;
  }

  if (selectedDefinitionIds.value.includes(definitionId)) {
    selectedDefinitionIds.value = normalizeSelectedDefinitionIds(selectedDefinitionIds.value.filter((item) => item !== definitionId));
    return;
  }

  if (!isDefinitionSelectable(definition)) {
    return;
  }

  selectedDefinitionIds.value = normalizeSelectedDefinitionIds([...selectedDefinitionIds.value, definitionId]);
}

function toggleExecutionItem(index: number): void {
  executionItems.value[index] = {
    ...executionItems.value[index],
    expanded: !executionItems.value[index]?.expanded,
  };
}

function openDefinitionSelector(nodeId: number): void {
  selectedNodeId.value = nodeId;
  selectedDefinitionIds.value = [];
  executionItems.value = [];
  executionError.value = "";
  pageStage.value = "definitions";
}

function backToDeviceList(): void {
  if (executionBusy.value) {
    return;
  }
  selectedDefinitionIds.value = [];
  executionItems.value = [];
  executionError.value = "";
  pageStage.value = "devices";
}

function backToDefinitionSelector(): void {
  if (executionBusy.value) {
    return;
  }
  executionItems.value = [];
  executionError.value = "";
  pageStage.value = "definitions";
}

async function refreshSupportedDefinitions(): Promise<void> {
  const nodes = runnableNodes.value;
  if (!nodes.length) {
    supportedDefinitionMap.value = {};
    return;
  }

  const currentToken = ++supportLoadToken;
  loadingDeviceMatrix.value = true;
  try {
    const results: Array<[number, TestDefinition[]]> = await Promise.all(nodes.map(async (node) => {
      try {
        const response = await apiClient.listSupportedDefinitions(node.nodeId);
        return [node.nodeId, response.items];
      } catch {
        return [node.nodeId, []];
      }
    }));

    if (currentToken !== supportLoadToken) {
      return;
    }

    supportedDefinitionMap.value = Object.fromEntries(results.map(([nodeId, definitions]) => [nodeId, definitions]));
  } finally {
    if (currentToken === supportLoadToken) {
      loadingDeviceMatrix.value = false;
    }
  }
}

watch(
  runnableNodes,
  async () => {
    await refreshSupportedDefinitions();
  },
  { immediate: true },
);

watch(
  selectedNodeDefinitions,
  (definitions) => {
    const allowedIds = new Set(definitions.map((definition) => definition.id));
    selectedDefinitionIds.value = normalizeSelectedDefinitionIds(selectedDefinitionIds.value.filter((id) => allowedIds.has(id)));

    if (pageStage.value !== "devices" && selectedNodeId.value && definitions.length === 0) {
      pageStage.value = "devices";
    }
  },
  { immediate: true },
);

watch(
  selectedNodeId,
  async () => {
    reportStatusMessage.value = "";
  },
  { immediate: true },
);

watch(
  controllerReady,
  (ready) => {
    if (ready || executionBusy.value) {
      return;
    }

    selectedNodeId.value = null;
    selectedDefinitionIds.value = [];
    executionItems.value = [];
    executionError.value = "";
    pageStage.value = "devices";
  },
  { immediate: true },
);

async function waitForRunCompletion(runId: string, token: number): Promise<TestRunRecord> {
  while (token === executionToken.value) {
    const liveRun = platform.runs.find((run) => run.id === runId);
    if (liveRun && TERMINAL_STATUSES.has(liveRun.status)) {
      await platform.loadRunLogs(runId);
      return liveRun;
    }

    await sleep(1000);
    await platform.refreshRuns();
    await platform.loadRunLogs(runId);
  }

  await platform.refreshRuns();
  const interruptedRun = platform.runs.find((run) => run.id === runId);
  if (interruptedRun && TERMINAL_STATUSES.has(interruptedRun.status)) {
    await platform.loadRunLogs(runId);
    return interruptedRun;
  }

  throw new Error("测试流程已停止。");
}

async function startSelectedTests(): Promise<void> {
  if (!selectedNode.value || !selectedDefinitions.value.length || hasBlockingRun.value) {
    return;
  }

  executionError.value = "";
  executionBusy.value = true;
  currentExecutionRunId.value = "";
  executionToken.value += 1;
  const token = executionToken.value;

  executionItems.value = selectedDefinitions.value.map((definition, index) => ({
    definition,
    status: "pending",
    expanded: index === 0,
  }));
  pageStage.value = "execution";

  try {
    for (let index = 0; index < executionItems.value.length; index += 1) {
      if (token !== executionToken.value) {
        break;
      }

      executionItems.value = executionItems.value.map((item, itemIndex) => ({
        ...item,
        expanded: itemIndex === index ? true : item.expanded,
      }));

      const currentItem = executionItems.value[index];
      currentItem.status = "queued";

      let run: TestRunRecord;
      try {
        run = await apiClient.createRun({
          nodeId: selectedNode.value.nodeId,
          testDefinitionId: currentItem.definition.id,
          inputs: {},
        });
      } catch (error) {
        currentItem.status = "failed";
        executionError.value = getErrorMessage(error);
        break;
      }

      currentItem.runId = run.id;
      currentItem.status = run.status;
      currentExecutionRunId.value = run.id;

      await platform.refreshRuns();
      await platform.loadRunLogs(run.id);

      const finalRun = await waitForRunCompletion(run.id, token);
      currentItem.status = finalRun.status;
      currentItem.expanded = false;
      currentExecutionRunId.value = "";

      if (finalRun.status === "cancelled") {
        executionError.value = "测试流程已取消。";
        break;
      }
    }
  } catch (error) {
    executionError.value = getErrorMessage(error);
  } finally {
    executionBusy.value = false;
    currentExecutionRunId.value = "";
    await platform.refreshRuns();
  }
}

async function cancelExecution(): Promise<void> {
  executionToken.value += 1;
  executionBusy.value = false;

  if (currentExecutionRunId.value) {
    await platform.cancelRun(currentExecutionRunId.value);
    currentExecutionRunId.value = "";
  }
}

async function skipActiveManualPrompt(): Promise<void> {
  if (!activeManualUnlockPrompt.value || manualPromptActionBusy.value) {
    return;
  }

  manualPromptActionBusy.value = true;
  try {
    await apiClient.submitRunManualAction(activeManualUnlockPrompt.value.runId, {
      promptKey: activeManualUnlockPrompt.value.promptKey,
      action: "skip",
    });
  } catch (error) {
    executionError.value = getErrorMessage(error);
  } finally {
    manualPromptActionBusy.value = false;
  }
}
</script>

<template>
  <div class="page-grid page-grid-single tests-page-grid">
    <section class="page-card tests-shell-card">
      <div class="section-heading section-heading-tight">
        <div>
          <p class="section-kicker">测试中心</p>
          <h3 v-if="pageStage === 'devices'">可测试设备列表</h3>
          <h3 v-else-if="pageStage === 'definitions'">选择测试项目</h3>
          <h3 v-else>测试执行详情</h3>
        </div>

        <div class="button-row">
          <button v-if="pageStage !== 'devices'" class="ghost-button" :disabled="executionBusy" @click="backToDeviceList">
            返回设备列表
          </button>
          <button v-if="pageStage === 'execution'" class="ghost-button" :disabled="executionBusy" @click="backToDefinitionSelector">
            重新选择测试项
          </button>
          <button v-if="pageStage === 'execution'" class="ghost-button" :disabled="!canExportExecutionReport" @click="generateAndSaveExecutionReport">
            生成测试报告
          </button>
          <button v-if="pageStage === 'execution' && executionBusy" class="ghost-button danger" @click="cancelExecution">
            取消当前测试
          </button>
        </div>
      </div>

      <div v-if="pageStage === 'devices'" class="stage-panel">
        <p v-if="controllerReady" class="panel-intro">进入测试页面后，先从可测试设备中选择目标设备，再进入测试项选择页面。</p>
        <p v-else class="warning-banner">请先连接 Controller，连接成功后才会显示可测试设备。</p>
        <p v-if="controllerReady && hasBlockingRun" class="warning-banner">当前已有测试任务正在执行，请等待完成后再启动新的测试。</p>
        <p v-if="controllerReady && loadingDeviceMatrix" class="empty-state">正在加载设备支持的测试项目...</p>

        <div v-else-if="controllerReady && testableDevices.length" class="device-table">
          <div class="device-table-row device-table-head">
            <span>节点 ID</span>
            <span>名称</span>
            <span>设备类型</span>
            <span>制造商</span>
            <span>支持的测试</span>
            <span>操作</span>
          </div>

          <div v-for="item in testableDevices" :key="item.node.nodeId" class="device-table-row">
            <span>#{{ item.node.nodeId }}</span>
            <span>{{ describeNode(item.node) }}</span>
            <span>{{ item.node.deviceType || '未识别' }}</span>
            <span>{{ item.node.manufacturer || '-' }}</span>
            <span class="device-tests">{{ formatDefinitionList(item.definitions) }}</span>
            <span>
              <button class="primary-button compact-button" :disabled="hasBlockingRun" @click="openDefinitionSelector(item.node.nodeId)">
                测试
              </button>
            </span>
          </div>
        </div>

        <p v-else-if="controllerReady" class="empty-state">当前没有可执行自动测试的设备，请先确认设备已完成采访并支持对应命令类。</p>
      </div>

      <div v-else-if="pageStage === 'definitions' && selectedNode" class="stage-panel stage-panel-definitions">
        <div class="selection-summary-card">
          <div>
            <p class="section-kicker">目标设备</p>
            <h4>#{{ selectedNode.nodeId }} {{ describeNode(selectedNode) }}</h4>
          </div>
          <div class="selection-summary-meta">
            <span>设备类型：{{ selectedNode.deviceType || '未识别' }}</span>
            <span>制造商：{{ selectedNode.manufacturer || '-' }}</span>
          </div>
        </div>

        <p class="panel-intro">可选择一个或多个测试项目，开始后会按选择顺序依次执行。</p>
        <p v-if="hasBlockingRun" class="warning-banner">当前已有测试任务正在执行，请等待当前任务结束后再开始。</p>

        <div class="definition-checklist">
          <label
            v-for="definition in selectedNodeDefinitions"
            :key="definition.id"
            class="definition-option"
            :class="{ 'definition-option-disabled': !isDefinitionSelectable(definition) }"
            :data-disabled-tip="!isDefinitionSelectable(definition) ? '请先选择“添加 User Code”' : undefined"
          >
            <input
              :checked="selectedDefinitionIds.includes(definition.id)"
              :disabled="!isDefinitionSelectable(definition)"
              type="checkbox"
              @change="toggleDefinition(definition.id)"
            />
            <div class="definition-option-body">
              <div class="definition-option-title-row">
                <strong>{{ definition.name }}</strong>
                <span class="definition-chip">{{ definition.deviceType }}</span>
              </div>
            </div>
          </label>
        </div>

        <div class="action-footer">
          <p class="empty-state">已选择 {{ selectedDefinitions.length }} 项测试</p>
          <button class="primary-button" :disabled="!selectedDefinitions.length || hasBlockingRun || executionBusy" @click="startSelectedTests">
            开始测试
          </button>
        </div>
      </div>

      <div v-else-if="pageStage === 'execution' && selectedNode" class="stage-panel execution-panel">
        <div v-if="activeManualUnlockPrompt" class="manual-unlock-overlay">
          <div class="manual-unlock-modal">
            <p class="section-kicker">人工验证</p>
            <h4>{{ activeManualUnlockPrompt.promptTitle }}</h4>
            <p class="manual-unlock-message">{{ activeManualUnlockPrompt.promptMessage }}</p>
            <p v-if="activeManualUnlockPrompt.promptMeta" class="manual-unlock-meta">{{ activeManualUnlockPrompt.promptMeta }}</p>
            <div v-if="activeManualUnlockPrompt.canSkip" class="button-row">
              <button class="ghost-button" :disabled="manualPromptActionBusy" @click="skipActiveManualPrompt">
                {{ activeManualUnlockPrompt.skipButtonLabel || "Skip" }}
              </button>
            </div>
          </div>
        </div>

        <div class="execution-header-card">
          <div>
            <p class="section-kicker">总测试标题</p>
            <h4>#{{ selectedNode.nodeId }} {{ describeNode(selectedNode) }}</h4>
            <p class="execution-subtitle">共 {{ executionItems.length }} 项测试，已完成 {{ completedExecutionCount }} 项，通过 {{ passedExecutionCount }} 项。</p>
          </div>
          <div class="execution-header-side">
            <span class="status-pill" :data-tone="overallExecutionStatus === 'passed' ? 'good' : overallExecutionStatus === 'failed' || overallExecutionStatus === 'cancelled' ? 'bad' : overallExecutionStatus === 'running' ? 'warn' : undefined">
              {{ translateExecutionStatus(overallExecutionStatus) }}
            </span>
            <strong>{{ progressPercent }}%</strong>
          </div>
        </div>

        <div class="progress-track">
          <div class="progress-fill" :style="{ width: `${progressPercent}%` }"></div>
        </div>

        <p v-if="executionError" class="warning-banner warning-banner-error">{{ executionError }}</p>
        <p v-if="reportStatusMessage" class="status-banner">{{ reportStatusMessage }}</p>

        <div class="execution-list">
          <article v-for="(item, index) in executionItems" :key="item.definition.id" class="execution-item" :data-status="getExecutionItemStatus(item)">
            <button class="execution-item-header" @click="toggleExecutionItem(index)">
              <div class="execution-item-header-main">
                <span class="execution-order">{{ index + 1 }}</span>
                <div>
                  <strong>{{ item.definition.name }}</strong>
                </div>
              </div>
              <div class="execution-item-header-side">
                <span class="status-pill" :data-tone="getExecutionItemStatus(item) === 'passed' ? 'good' : getExecutionItemStatus(item) === 'failed' || getExecutionItemStatus(item) === 'cancelled' ? 'bad' : getExecutionItemStatus(item) === 'running' || getExecutionItemStatus(item) === 'queued' ? 'warn' : undefined">
                  {{ translateExecutionStatus(getExecutionItemStatus(item)) }}
                </span>
                <span class="accordion-arrow" :data-expanded="item.expanded">▾</span>
              </div>
            </button>

            <div v-if="item.expanded" class="execution-item-body">
              <div v-if="item.runId" class="run-id-line">任务 ID：{{ item.runId }}</div>

              <div v-if="getExecutionLogs(item).length" class="step-list">
                <div v-for="(log, logIndex) in getExecutionLogs(item)" :key="log.id" class="step-row">
                  <div class="step-index">{{ logIndex + 1 }}</div>
                  <div class="step-indicator" :data-state="getLogStepState(item, logIndex, getExecutionLogs(item))">
                    <span v-if="getLogStepState(item, logIndex, getExecutionLogs(item)) === 'running'" class="spinner"></span>
                    <span v-else-if="getLogStepState(item, logIndex, getExecutionLogs(item)) === 'passed'">✓</span>
                    <span v-else-if="getLogStepState(item, logIndex, getExecutionLogs(item)) === 'failed'">✕</span>
                    <span v-else-if="getLogStepState(item, logIndex, getExecutionLogs(item)) === 'warn'">!</span>
                    <span v-else>·</span>
                  </div>
                  <div class="step-content">
                    <div class="step-content-header">
                      <strong>{{ log.message }}</strong>
                      <span>{{ new Date(log.timestamp).toLocaleTimeString() }}</span>
                    </div>
                    <pre v-if="shouldShowLogPayload(log)" class="code-block step-payload">{{ formatLogPayload(log) }}</pre>
                  </div>
                </div>
              </div>

              <div v-else class="step-row step-row-placeholder">
                <div class="step-index">1</div>
                <div class="step-indicator" :data-state="getPlaceholderStepState(item)">
                  <span v-if="getPlaceholderStepState(item) === 'running'" class="spinner"></span>
                  <span v-else-if="getPlaceholderStepState(item) === 'failed'">✕</span>
                  <span v-else>·</span>
                </div>
                <div class="step-content">
                  <strong>{{ getPlaceholderStepMessage(item) }}</strong>
                </div>
              </div>
            </div>
          </article>
        </div>

      </div>
    </section>
  </div>
</template>

<style scoped>
.tests-page-grid {
  min-height: 100%;
}

.tests-shell-card {
  display: grid;
  gap: 18px;
}

.stage-panel {
  display: grid;
  gap: 18px;
}

.section-heading-tight {
  margin-bottom: 0;
}

.panel-intro {
  margin: 0;
  color: var(--muted);
}

.warning-banner {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid rgba(194, 125, 18, 0.24);
  background: rgba(255, 247, 231, 0.92);
  color: #9a6413;
}

.warning-banner-error {
  border-color: rgba(165, 58, 44, 0.24);
  background: rgba(255, 239, 236, 0.92);
  color: var(--bad);
}

.status-banner {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid rgba(92, 57, 181, 0.18);
  background: rgba(244, 239, 255, 0.82);
  color: var(--accent-deep);
}

.device-table {
  display: grid;
  gap: 10px;
}

.device-table-row {
  display: grid;
  grid-template-columns: 96px minmax(180px, 1.2fr) minmax(120px, 0.8fr) minmax(140px, 0.9fr) minmax(240px, 1.6fr) 96px;
  gap: 16px;
  align-items: center;
  padding: 16px 18px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.74);
}

.device-table-head {
  background: rgba(240, 233, 255, 0.8);
  font-size: 0.86rem;
  font-weight: 700;
  color: var(--muted);
}

.device-tests {
  color: var(--muted);
}

.compact-button {
  min-height: 38px;
  padding: 0 16px;
}

.selection-summary-card,
.execution-header-card,
.definition-option,
.execution-item {
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.74);
}

.selection-summary-card,
.execution-header-card {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  padding: 18px;
}

.selection-summary-card h4,
.execution-header-card h4,
.execution-subtitle,
.definition-option p {
  margin: 0;
}

.selection-summary-meta {
  display: grid;
  gap: 6px;
  color: var(--muted);
  text-align: right;
}

.definition-checklist,
.execution-list {
  display: grid;
  gap: 14px;
}

.stage-panel-definitions .definition-checklist {
  grid-template-columns: repeat(6, minmax(0, 1fr));
  align-items: stretch;
}

.definition-option {
  position: relative;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
  padding: 18px;
  cursor: pointer;
  transition: transform 180ms ease, border-color 180ms ease, background 180ms ease, box-shadow 180ms ease;
}

.definition-option:hover {
  transform: translateY(-2px);
  border-color: rgba(142, 113, 232, 0.28);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(244, 237, 255, 0.82));
  box-shadow: 0 16px 30px rgba(132, 102, 196, 0.1);
}

.definition-option:has(input:checked) {
  border-color: rgba(142, 113, 232, 0.46);
  background: linear-gradient(180deg, rgba(245, 238, 255, 0.98), rgba(234, 223, 255, 0.92));
  box-shadow: 0 18px 34px rgba(132, 102, 196, 0.14);
}

.definition-option input {
  margin-top: 4px;
  width: 18px;
  height: 18px;
}

.definition-option-disabled::after {
  content: attr(data-disabled-tip);
  position: absolute;
  left: 50%;
  bottom: calc(100% + 12px);
  transform: translate(-50%, 6px);
  padding: 8px 12px;
  border-radius: 12px;
  background: rgba(33, 24, 54, 0.94);
  color: #fff;
  font-size: 0.8rem;
  line-height: 1.4;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  box-shadow: 0 14px 24px rgba(33, 24, 54, 0.18);
  transition: opacity 160ms ease, transform 160ms ease;
}

.definition-option-disabled:hover::after {
  opacity: 1;
  transform: translate(-50%, 0);
}

.definition-option-body {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.definition-option-title-row {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-start;
}

.definition-option-title-row strong {
  font-size: 0.98rem;
  line-height: 1.35;
}

.definition-option p {
  color: var(--muted);
}

.definition-chip {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  padding: 0 10px;
  background: rgba(92, 57, 181, 0.1);
  color: var(--accent-deep);
  font-size: 0.78rem;
  font-weight: 700;
  white-space: nowrap;
}

.action-footer {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
}

.execution-panel {
  gap: 16px;
}

.manual-unlock-overlay {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(44, 32, 71, 0.18);
  backdrop-filter: blur(6px);
}

.manual-unlock-modal {
  width: min(560px, 100%);
  display: grid;
  gap: 14px;
  padding: 28px;
  border: 1px solid rgba(142, 113, 232, 0.28);
  border-radius: 24px;
  background: linear-gradient(180deg, rgba(255, 252, 255, 0.98), rgba(242, 234, 255, 0.94));
  box-shadow: 0 24px 56px rgba(97, 73, 153, 0.24);
}

.manual-unlock-modal h4,
.manual-unlock-message,
.manual-unlock-meta {
  margin: 0;
}

.manual-unlock-message {
  font-size: 1.08rem;
  font-weight: 700;
  line-height: 1.5;
}

.manual-unlock-meta {
  color: var(--muted);
}

.execution-header-side {
  display: grid;
  gap: 8px;
  justify-items: end;
}

.execution-subtitle {
  margin-top: 8px;
  color: var(--muted);
}

.progress-track {
  width: 100%;
  height: 12px;
  overflow: hidden;
  background: rgba(221, 214, 241, 0.72);
}

.progress-fill {
  height: 100%;
  background: linear-gradient(135deg, var(--accent), var(--accent-deep));
  transition: width 180ms ease;
}

.execution-item {
  overflow: hidden;
}

.execution-item-header {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  padding: 18px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.execution-item-header-main {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.execution-item-header-main p,
.run-id-line,
.step-key {
  margin: 6px 0 0;
  color: var(--muted);
}

.execution-item-header-side {
  display: flex;
  gap: 12px;
  align-items: center;
}

.execution-order,
.step-index {
  width: 32px;
  min-width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(92, 57, 181, 0.1);
  color: var(--accent-deep);
  font-weight: 700;
}

.accordion-arrow {
  color: var(--muted);
  transition: transform 180ms ease;
}

.accordion-arrow[data-expanded="true"] {
  transform: rotate(180deg);
}

.execution-item-body {
  padding: 0 18px 18px;
  display: grid;
  gap: 14px;
}

.step-list {
  display: grid;
  gap: 12px;
}

.step-row {
  display: grid;
  grid-template-columns: 32px 32px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  padding-top: 12px;
  border-top: 1px dashed rgba(123, 66, 255, 0.22);
}

.step-row-placeholder {
  border-top: 1px dashed rgba(123, 66, 255, 0.22);
}

.step-indicator {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  color: var(--muted);
}

.step-indicator[data-state="passed"] {
  color: var(--good);
  border-color: rgba(47, 125, 75, 0.24);
  background: rgba(230, 247, 235, 0.88);
}

.step-indicator[data-state="failed"] {
  color: var(--bad);
  border-color: rgba(165, 58, 44, 0.24);
  background: rgba(255, 239, 236, 0.88);
}

.step-indicator[data-state="running"] {
  color: var(--warn);
  border-color: rgba(194, 125, 18, 0.24);
  background: rgba(255, 247, 231, 0.88);
}

.step-indicator[data-state="warn"] {
  color: #9a6413;
  border-color: rgba(194, 125, 18, 0.32);
  background: rgba(255, 240, 205, 0.92);
}

.step-content {
  min-width: 0;
}

.step-content-header {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  align-items: center;
}

.step-content-header span {
  color: var(--muted);
  font-size: 0.82rem;
}

.step-payload {
  margin-top: 10px;
  padding: 12px 14px;
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1080px) {
  .device-table-row {
    grid-template-columns: 96px minmax(140px, 1fr) minmax(120px, 0.8fr) minmax(120px, 0.8fr);
  }

  .stage-panel-definitions .definition-checklist {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .device-table-row span:nth-child(5),
  .device-table-row span:nth-child(6),
  .device-table-head span:nth-child(5),
  .device-table-head span:nth-child(6) {
    grid-column: span 2;
  }
}

@media (max-width: 720px) {
  .selection-summary-card,
  .execution-header-card,
  .action-footer,
  .execution-item-header,
  .step-content-header {
    grid-template-columns: 1fr;
    flex-direction: column;
    align-items: flex-start;
  }

  .selection-summary-meta,
  .execution-header-side {
    text-align: left;
    justify-items: start;
  }

  .device-table-row {
    grid-template-columns: 1fr;
  }

  .stage-panel-definitions .definition-checklist {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .device-table-head {
    display: none;
  }

  .step-row {
    grid-template-columns: 28px 28px minmax(0, 1fr);
  }
}

@media (max-width: 560px) {
  .stage-panel-definitions .definition-checklist {
    grid-template-columns: 1fr;
  }
}
</style>

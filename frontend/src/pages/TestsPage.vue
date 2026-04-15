<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { apiClient } from "../api/client";
import { usePlatformStore } from "../stores/platform";
import type { NodeSummary, TestDefinition, TestLogRecord, TestRunRecord } from "../types";
import { translateRunStatus } from "../utils/ui-text";

type TestPageStage = "devices" | "definitions" | "execution";
type ExecutionStatus = TestRunRecord["status"] | "pending";
type StepState = "pending" | "running" | "passed" | "failed";

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
const currentExecutionRunId = ref("");
const executionToken = ref(0);
let supportLoadToken = 0;

const runnableNodes = computed(() => {
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
  return supportedDefinitionMap.value[selectedNodeId.value] ?? [];
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function describeNode(node: NodeSummary): string {
  return node.product || node.name || node.manufacturer || `节点 ${node.nodeId}`;
}

function formatDefinitionList(definitions: TestDefinition[]): string {
  return definitions.map((definition) => definition.name).join(" / ");
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

function getExecutionLogs(item: ExecutionItem): TestLogRecord[] {
  if (!item.runId) {
    return [];
  }
  return platform.runLogs[item.runId] ?? [];
}

function getLogStepState(item: ExecutionItem, index: number, logs: TestLogRecord[]): StepState {
  const log = logs[index];
  if (log?.level === "error") {
    return "failed";
  }
  if (index === logs.length - 1) {
    const status = getExecutionItemStatus(item);
    if (status === "running" || status === "queued") {
      return "running";
    }
  }
  return "passed";
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

function toggleDefinition(definitionId: string): void {
  if (selectedDefinitionIds.value.includes(definitionId)) {
    selectedDefinitionIds.value = selectedDefinitionIds.value.filter((item) => item !== definitionId);
    return;
  }
  selectedDefinitionIds.value = [...selectedDefinitionIds.value, definitionId];
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
    selectedDefinitionIds.value = selectedDefinitionIds.value.filter((id) => allowedIds.has(id));

    if (pageStage.value !== "devices" && selectedNodeId.value && definitions.length === 0) {
      pageStage.value = "devices";
    }
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
          <button v-if="pageStage === 'execution' && executionBusy" class="ghost-button danger" @click="cancelExecution">
            取消当前测试
          </button>
        </div>
      </div>

      <div v-if="pageStage === 'devices'" class="stage-panel">
        <p class="panel-intro">进入测试页面后，先从可测试设备中选择目标设备，再进入测试项选择页面。</p>
        <p v-if="hasBlockingRun" class="warning-banner">当前已有测试任务正在执行，请等待完成后再启动新的测试。</p>
        <p v-if="loadingDeviceMatrix" class="empty-state">正在加载设备支持的测试项目...</p>

        <div v-else-if="testableDevices.length" class="device-table">
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

        <p v-else class="empty-state">当前没有可执行自动测试的设备，请先确认设备已完成采访并支持对应命令类。</p>
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
          <label v-for="definition in selectedNodeDefinitions" :key="definition.id" class="definition-option">
            <input :checked="selectedDefinitionIds.includes(definition.id)" type="checkbox" @change="toggleDefinition(definition.id)" />
            <div class="definition-option-body">
              <div class="definition-option-title-row">
                <strong>{{ definition.name }}</strong>
                <span class="definition-chip">{{ definition.deviceType }}</span>
              </div>
              <p>{{ definition.description }}</p>
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
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
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

<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { apiClient } from "../api/client";
import { usePlatformStore } from "../stores/platform";
import type { NodeSummary, TestDefinition, TestLogRecord } from "../types";
import { translateRunStatus } from "../utils/ui-text";

const platform = usePlatformStore();
const doorLockQuickActions = [
  { id: "lock-unlock-v1", label: "单独开锁" },
  { id: "lock-lock-v1", label: "单独关锁" },
] as const;

const selectedNodeId = ref<number | null>(null);
const selectedDefinitionId = ref("");
const selectedRunId = ref("");
const supportedDefinitions = ref<TestDefinition[]>([]);
const loadingSupportedDefinitions = ref(false);
const submitting = ref(false);

const runnableNodes = computed(() => {
  return [...platform.nodes]
    .filter((node) => node.nodeId !== platform.status.controllerId && node.deviceType !== "Controller")
    .sort((left, right) => left.nodeId - right.nodeId);
});

const definitionMap = computed(() => {
  return new Map(platform.definitions.map((definition) => [definition.id, definition]));
});

const selectedNode = computed(() => {
  return runnableNodes.value.find((node) => node.nodeId === selectedNodeId.value) ?? null;
});

const selectedDefinition = computed(() => {
  return supportedDefinitions.value.find((definition) => definition.id === selectedDefinitionId.value) ?? null;
});

const hasRunningRun = computed(() => {
  return platform.runs.some((run) => run.status === "running");
});

const isDoorLockNode = computed(() => {
  return selectedNode.value?.commandClasses.includes("Door Lock") ?? false;
});

const selectedRun = computed(() => {
  if (selectedRunId.value) {
    return platform.runs.find((run) => run.id === selectedRunId.value) ?? null;
  }
  return platform.runs[0] ?? null;
});

const activeLogs = computed(() => {
  if (!selectedRun.value) {
    return [];
  }
  return platform.runLogs[selectedRun.value.id] ?? [];
});

const canStartTest = computed(() => {
  return Boolean(selectedNode.value && selectedDefinition.value && !submitting.value && !hasRunningRun.value);
});

function describeNode(node: NodeSummary): string {
  return node.product || node.name || node.manufacturer || `节点 ${node.nodeId}`;
}

function resolveDefinitionName(definitionId: string): string {
  return definitionMap.value.get(definitionId)?.name ?? definitionId;
}

function resolveRunNode(runNodeId: number): NodeSummary | undefined {
  return platform.nodes.find((node) => node.nodeId === runNodeId);
}

function formatLogPayload(log: TestLogRecord): string {
  return log.payloadJson ? JSON.stringify(log.payloadJson, null, 2) : "";
}

watch(
  runnableNodes,
  (nodes) => {
    if (!nodes.length) {
      selectedNodeId.value = null;
      selectedDefinitionId.value = "";
      supportedDefinitions.value = [];
      return;
    }

    if (!nodes.some((node) => node.nodeId === selectedNodeId.value)) {
      selectedNodeId.value = nodes[0]?.nodeId ?? null;
    }
  },
  { immediate: true },
);

watch(
  selectedNodeId,
  async (nodeId) => {
    selectedDefinitionId.value = "";
    supportedDefinitions.value = [];

    if (!nodeId) {
      return;
    }

    loadingSupportedDefinitions.value = true;
    try {
      supportedDefinitions.value = (await apiClient.listSupportedDefinitions(nodeId)).items;
      if (supportedDefinitions.value.length === 1) {
        selectedDefinitionId.value = supportedDefinitions.value[0]?.id ?? "";
      }
    } finally {
      loadingSupportedDefinitions.value = false;
    }
  },
  { immediate: true },
);

watch(
  () => platform.runs,
  (runs) => {
    if (!runs.length) {
      selectedRunId.value = "";
      return;
    }

    if (!runs.some((run) => run.id === selectedRunId.value)) {
      selectedRunId.value = runs[0]?.id ?? "";
    }
  },
  { immediate: true },
);

watch(
  selectedRun,
  async (run) => {
    if (run && !platform.runLogs[run.id]) {
      await platform.loadRunLogs(run.id);
    }
  },
  { immediate: true },
);

async function submit(): Promise<void> {
  if (!selectedDefinition.value) {
    return;
  }

  await submitByDefinitionId(selectedDefinition.value.id);
}

async function submitByDefinitionId(definitionId: string): Promise<void> {
  if (!selectedNode.value) {
    return;
  }

  submitting.value = true;
  try {
    await platform.runTest({
      nodeId: selectedNode.value.nodeId,
      testDefinitionId: definitionId,
      inputs: {},
    });

    selectedDefinitionId.value = definitionId;
    selectedRunId.value = platform.runs[0]?.id ?? "";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="page-grid split-wide">
    <section class="page-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">测试配置</p>
          <h3>选择设备并执行测试</h3>
        </div>
      </div>

      <label class="field-stack">
        <span>测试设备</span>
        <select v-model="selectedNodeId" class="text-input">
          <option :value="null">请选择设备</option>
          <option v-for="node in runnableNodes" :key="node.nodeId" :value="node.nodeId">
            #{{ node.nodeId }} {{ describeNode(node) }}
          </option>
        </select>
      </label>

      <div v-if="selectedNode" class="device-brief-card">
        <div>
          <dt>设备名称</dt>
          <dd>{{ describeNode(selectedNode) }}</dd>
        </div>
        <div>
          <dt>设备类型</dt>
          <dd>{{ selectedNode.deviceType || "未识别" }}</dd>
        </div>
        <div>
          <dt>制造商</dt>
          <dd>{{ selectedNode.manufacturer || "-" }}</dd>
        </div>
        <div>
          <dt>命令类</dt>
          <dd>{{ selectedNode.commandClasses.join(" / ") || "-" }}</dd>
        </div>
      </div>

      <label class="field-stack">
        <span>测试功能</span>
        <select v-model="selectedDefinitionId" class="text-input" :disabled="loadingSupportedDefinitions || !selectedNode">
          <option value="">{{ loadingSupportedDefinitions ? "正在加载可用测试..." : "请选择测试功能" }}</option>
          <option v-for="definition in supportedDefinitions" :key="definition.id" :value="definition.id">
            {{ definition.name }}
          </option>
        </select>
      </label>

      <div v-if="selectedDefinition" class="definition-card">
        <p class="definition-tag">{{ selectedDefinition.deviceType }}</p>
        <h4>{{ selectedDefinition.name }}</h4>
        <p>{{ selectedDefinition.description }}</p>
      </div>
      <p v-else-if="selectedNode && !loadingSupportedDefinitions" class="empty-state">
        当前设备暂无可执行的自动测试。
      </p>

      <div v-if="isDoorLockNode" class="quick-action-card">
        <div>
          <p class="section-kicker">快速控制</p>
          <h4>单独执行开锁 / 关锁</h4>
          <p>直接发送单次门锁命令，并校验最终锁舌状态，方便快速验证门锁响应。</p>
        </div>
        <div class="button-row">
          <button
            v-for="action in doorLockQuickActions"
            :key="action.id"
            class="ghost-button"
            :disabled="submitting || hasRunningRun || !selectedNode"
            @click="submitByDefinitionId(action.id)"
          >
            {{ action.label }}
          </button>
        </div>
      </div>

      <button class="primary-button" :disabled="!canStartTest" @click="submit">启动测试</button>
    </section>

    <section class="page-card accent-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">执行记录</p>
          <h3>任务与日志</h3>
        </div>
      </div>

      <div class="list-column compact run-list">
        <button
          v-for="run in platform.runs"
          :key="run.id"
          class="list-card run-card"
          :data-active="run.id === selectedRun?.id"
          @click="selectedRunId = run.id"
        >
          <div>
            <strong>{{ resolveDefinitionName(run.testDefinitionId) }}</strong>
            <p>#{{ run.nodeId }} {{ describeNode(resolveRunNode(run.nodeId) || { nodeId: run.nodeId, securityClasses: [], isSecure: false, isListening: false, commandClasses: [] }) }}</p>
          </div>
          <span>{{ translateRunStatus(run.status) }}</span>
        </button>
      </div>

      <div v-if="selectedRun" class="run-summary run-summary-block">
        <div>
          <p class="mono-line">当前任务：{{ selectedRun.id }}</p>
          <p class="mono-line">测试项：{{ resolveDefinitionName(selectedRun.testDefinitionId) }}</p>
        </div>
        <button
          class="ghost-button danger"
          :disabled="selectedRun.status !== 'running'"
          @click="platform.cancelRun(selectedRun.id)"
        >
          取消任务
        </button>
      </div>

      <div v-if="activeLogs.length" class="log-stream">
        <article v-for="log in activeLogs" :key="log.id" class="log-entry" :data-level="log.level">
          <div class="log-entry-header">
            <strong>{{ log.message }}</strong>
            <span>{{ new Date(log.timestamp).toLocaleTimeString() }}</span>
          </div>
          <p class="log-step">{{ log.stepKey }}</p>
          <pre v-if="log.payloadJson" class="code-block log-payload">{{ formatLogPayload(log) }}</pre>
        </article>
      </div>
      <p v-else class="empty-state">选择一条测试记录后，这里会显示执行日志。</p>
    </section>
  </div>
</template>

<style scoped>
.device-brief-card,
.quick-action-card,
.definition-card,
.log-entry {
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.7);
}

.device-brief-card {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 16px;
  padding: 16px;
  border-radius: 18px;
}

.device-brief-card dt,
.log-step {
  color: var(--muted);
  font-size: 0.84rem;
}

.device-brief-card dd {
  margin: 6px 0 0;
  font-weight: 600;
}

.definition-card {
  margin-bottom: 18px;
  padding: 18px;
  border-radius: 18px;
}

.quick-action-card {
  display: grid;
  gap: 14px;
  margin-bottom: 18px;
  padding: 18px;
  border-radius: 18px;
}

.definition-card h4,
.definition-card p,
.quick-action-card h4,
.quick-action-card p {
  margin: 0;
}

.definition-card p + p {
  margin-top: 8px;
}

.definition-tag {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 10px;
  margin-bottom: 10px;
  border-radius: 999px;
  background: rgba(92, 57, 181, 0.1);
  color: var(--accent-deep);
  font-size: 0.8rem;
  font-weight: 700;
}

.run-list {
  margin-bottom: 18px;
}

.run-card[data-active="true"] {
  border-color: rgba(123, 66, 255, 0.45);
  background: rgba(238, 229, 255, 0.9);
}

.run-summary-block {
  align-items: flex-start;
}

.log-stream {
  display: grid;
  gap: 12px;
}

.log-entry {
  padding: 14px 16px;
  border-radius: 18px;
}

.log-entry[data-level="error"] {
  border-color: rgba(165, 58, 44, 0.24);
}

.log-entry[data-level="warn"] {
  border-color: rgba(194, 125, 18, 0.24);
}

.log-entry-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
}

.log-entry-header span {
  color: var(--muted);
  font-size: 0.82rem;
}

.log-step {
  margin: 6px 0 0;
}

.log-payload {
  margin-top: 12px;
  padding: 12px 14px;
}

@media (max-width: 720px) {
  .device-brief-card {
    grid-template-columns: 1fr;
  }

  .log-entry-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>

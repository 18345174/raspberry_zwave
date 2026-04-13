<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { apiClient } from "../api/client";
import { usePlatformStore } from "../stores/platform";
import type {
  FirmwareFileInspection,
  FirmwareUpdateCapabilities,
  FirmwareUpdateStatus,
  NodeSummary,
} from "../types";

const platform = usePlatformStore();

const selectedNodeId = ref<number | null>(null);
const capabilities = ref<FirmwareUpdateCapabilities | null>(null);
const inspection = ref<FirmwareFileInspection | null>(null);
const upgradeStatus = ref<FirmwareUpdateStatus | null>(null);
const selectedFile = ref<File | null>(null);
const fileContentBase64 = ref("");
const selectedTarget = ref<number | null>(null);
const resume = ref(false);
const nonSecureTransfer = ref(false);
const loadingCapabilities = ref(false);
const inspectingFile = ref(false);
const startingUpgrade = ref(false);
const abortingUpgrade = ref(false);
const statusMessage = ref("请选择设备并上传固件文件");

let pollTimer: number | null = null;

const candidateNodes = computed(() => {
  return [...platform.nodes]
    .filter((node) =>
      node.nodeId !== platform.status.controllerId
      && node.commandClasses.includes("Firmware Update Meta Data"))
    .sort((left, right) => left.nodeId - right.nodeId);
});

const selectedNode = computed(() => {
  return candidateNodes.value.find((node) => node.nodeId === selectedNodeId.value) ?? null;
});

const isRunning = computed(() => {
  return upgradeStatus.value?.phase === "preparing" || upgradeStatus.value?.phase === "running";
});

const canStartUpgrade = computed(() => {
  return Boolean(
    selectedNodeId.value
      && capabilities.value?.firmwareUpgradable
      && fileContentBase64.value
      && selectedTarget.value != null
      && !isRunning.value
      && !startingUpgrade.value,
  );
});

const targetOptions = computed(() => capabilities.value?.firmwareTargets ?? []);

const detectedTargetMismatch = computed(() => {
  return inspection.value?.detectedTarget != undefined
    && selectedTarget.value != null
    && inspection.value.detectedTarget !== selectedTarget.value;
});

watch(
  candidateNodes,
  (nodes) => {
    if (!nodes.length) {
      selectedNodeId.value = null;
      capabilities.value = null;
      inspection.value = null;
      upgradeStatus.value = null;
      stopPolling();
      statusMessage.value = "当前没有可升级固件的设备节点";
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
    stopPolling();
    capabilities.value = null;
    inspection.value = null;
    upgradeStatus.value = null;
    selectedFile.value = null;
    fileContentBase64.value = "";
    selectedTarget.value = null;
    resume.value = false;
    nonSecureTransfer.value = false;

    if (!nodeId) {
      statusMessage.value = "请选择设备并上传固件文件";
      return;
    }

    await loadNodeContext(nodeId);
  },
  { immediate: true },
);

watch(capabilities, (value) => {
  if (!value?.supportsResuming) {
    resume.value = false;
  }
  if (!value?.supportsNonSecureTransfer) {
    nonSecureTransfer.value = false;
  }
  applyDefaultTarget();
});

watch(inspection, () => {
  applyDefaultTarget();
});

onBeforeUnmount(() => {
  stopPolling();
});

function describeNode(node: NodeSummary): string {
  return node.product || node.name || node.manufacturer || `节点 ${node.nodeId}`;
}

function formatBytes(bytes?: number): string {
  if (!bytes) {
    return "-";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(value?: string): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function phaseLabel(phase?: FirmwareUpdateStatus["phase"]): string {
  switch (phase) {
    case "preparing":
      return "准备中";
    case "running":
      return "升级中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "aborted":
      return "已取消";
    default:
      return "未开始";
  }
}

function phaseTone(phase?: FirmwareUpdateStatus["phase"]): "good" | "warn" | "bad" {
  switch (phase) {
    case "completed":
      return "good";
    case "preparing":
    case "running":
      return "warn";
    case "failed":
    case "aborted":
      return "bad";
    default:
      return "warn";
  }
}

function applyDefaultTarget(): void {
  const targets = targetOptions.value;
  if (!targets.length) {
    selectedTarget.value = null;
    return;
  }

  if (inspection.value?.detectedTarget != undefined && targets.includes(inspection.value.detectedTarget)) {
    selectedTarget.value = inspection.value.detectedTarget;
    return;
  }

  if (selectedTarget.value == null || !targets.includes(selectedTarget.value)) {
    selectedTarget.value = targets[0] ?? null;
  }
}

function shouldPoll(status: FirmwareUpdateStatus | null): boolean {
  return status?.phase === "preparing" || status?.phase === "running";
}

function startPolling(): void {
  if (pollTimer != null || !selectedNodeId.value) {
    return;
  }

  const poll = async () => {
    if (!selectedNodeId.value) {
      pollTimer = null;
      return;
    }

    try {
      const response = await apiClient.getFirmwareUpdateStatus(selectedNodeId.value);
      upgradeStatus.value = response.status;
      if (upgradeStatus.value?.message) {
        statusMessage.value = upgradeStatus.value.message;
      }

      if (!shouldPoll(upgradeStatus.value)) {
        pollTimer = null;
        if (upgradeStatus.value?.phase === "completed") {
          await platform.refreshNodes().catch(() => undefined);
        }
        return;
      }
    } catch {
      // Ignore transient polling failures during OTA.
    }

    pollTimer = window.setTimeout(poll, 1000);
  };

  pollTimer = window.setTimeout(poll, 1000);
}

function stopPolling(): void {
  if (pollTimer == null) {
    return;
  }
  window.clearTimeout(pollTimer);
  pollTimer = null;
}

async function loadNodeContext(nodeId: number): Promise<void> {
  loadingCapabilities.value = true;
  statusMessage.value = `正在读取节点 ${nodeId} 的固件升级能力...`;

  try {
    const [capabilityResult, statusResult] = await Promise.all([
      apiClient.getFirmwareUpdateCapabilities(nodeId),
      apiClient.getFirmwareUpdateStatus(nodeId),
    ]);
    capabilities.value = capabilityResult;
    upgradeStatus.value = statusResult.status;

    if (!capabilityResult.firmwareUpgradable) {
      statusMessage.value = `节点 ${nodeId} 当前未声明支持固件升级`;
    } else if (upgradeStatus.value?.message) {
      statusMessage.value = upgradeStatus.value.message;
    } else {
      statusMessage.value = `节点 ${nodeId} 支持目标 ${capabilityResult.firmwareTargets.join(", ")}`;
    }

    if (shouldPoll(upgradeStatus.value)) {
      startPolling();
    }
  } catch (error) {
    statusMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loadingCapabilities.value = false;
  }
}

async function refreshNodeList(): Promise<void> {
  await platform.refreshNodes();
  if (selectedNodeId.value) {
    await loadNodeContext(selectedNodeId.value);
  }
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(new Error("读取固件文件失败。"));
    reader.readAsDataURL(file);
  });
}

async function handleFileSelect(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  selectedFile.value = file;
  inspection.value = null;
  fileContentBase64.value = "";

  if (!file) {
    statusMessage.value = "请选择固件文件";
    return;
  }
  if (!selectedNodeId.value) {
    statusMessage.value = "请先选择设备节点";
    return;
  }

  inspectingFile.value = true;
  statusMessage.value = `正在解析固件文件 ${file.name}...`;

  try {
    fileContentBase64.value = await fileToBase64(file);
    inspection.value = await apiClient.inspectFirmwareFile(selectedNodeId.value, {
      filename: file.name,
      contentBase64: fileContentBase64.value,
    });
    statusMessage.value = `固件文件解析完成：${inspection.value.firmwareFilename}`;
  } catch (error) {
    selectedFile.value = null;
    fileContentBase64.value = "";
    inspection.value = null;
    statusMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    inspectingFile.value = false;
    input.value = "";
  }
}

async function startUpgrade(): Promise<void> {
  if (!selectedNodeId.value || !selectedFile.value || !fileContentBase64.value || selectedTarget.value == null) {
    statusMessage.value = "请先选择节点、固件文件和目标位置";
    return;
  }

  startingUpgrade.value = true;
  statusMessage.value = "正在启动固件升级...";

  try {
    upgradeStatus.value = await apiClient.startFirmwareUpdate(selectedNodeId.value, {
      filename: selectedFile.value.name,
      contentBase64: fileContentBase64.value,
      target: selectedTarget.value,
      resume: resume.value,
      nonSecureTransfer: nonSecureTransfer.value,
    });
    statusMessage.value = upgradeStatus.value.message ?? "固件升级已开始";
    startPolling();
  } catch (error) {
    statusMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    startingUpgrade.value = false;
  }
}

async function abortUpgrade(): Promise<void> {
  if (!selectedNodeId.value || !isRunning.value) {
    return;
  }

  abortingUpgrade.value = true;
  statusMessage.value = "正在取消固件升级...";

  try {
    await apiClient.abortFirmwareUpdate(selectedNodeId.value);
    const response = await apiClient.getFirmwareUpdateStatus(selectedNodeId.value);
    upgradeStatus.value = response.status;
    statusMessage.value = upgradeStatus.value?.message ?? "已发送取消请求";
    if (shouldPoll(upgradeStatus.value)) {
      startPolling();
    }
  } catch (error) {
    statusMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    abortingUpgrade.value = false;
  }
}
</script>

<template>
  <div class="page-grid page-grid-single firmware-page-grid">
    <section class="page-card firmware-card">
      <div class="section-heading section-heading-tight firmware-heading">
        <div>
          <p class="section-kicker">Z-Wave OTA</p>
          <h3>设备固件升级</h3>
        </div>

        <div class="button-row">
          <button class="ghost-button" @click="refreshNodeList">刷新节点</button>
          <button class="ghost-button danger" :disabled="!isRunning || abortingUpgrade" @click="abortUpgrade">
            {{ abortingUpgrade ? '取消中...' : '取消升级' }}
          </button>
          <button class="primary-button" :disabled="!canStartUpgrade || inspectingFile || loadingCapabilities" @click="startUpgrade">
            {{ startingUpgrade ? '启动中...' : '开始升级' }}
          </button>
        </div>
      </div>

      <div class="firmware-toolbar-grid">
        <label class="field-stack">
          <span>设备列表</span>
          <select v-model="selectedNodeId" class="text-input" :disabled="!candidateNodes.length || isRunning">
            <option :value="null">请选择节点</option>
            <option v-for="node in candidateNodes" :key="node.nodeId" :value="node.nodeId">
              #{{ node.nodeId }} {{ describeNode(node) }}
            </option>
          </select>
        </label>

        <label class="field-stack">
          <span>固件文件</span>
          <input class="text-input firmware-file-input" type="file" :disabled="!selectedNodeId || isRunning" @change="handleFileSelect" />
        </label>

        <label class="field-stack">
          <span>芯片位置 / Target</span>
          <select v-model="selectedTarget" class="text-input" :disabled="!targetOptions.length || isRunning">
            <option :value="null">请选择目标</option>
            <option v-for="target in targetOptions" :key="target" :value="target">
              Target {{ target }}
            </option>
          </select>
        </label>
      </div>

      <p class="status-banner firmware-status-banner">{{ statusMessage }}</p>

      <div v-if="selectedNode" class="selection-summary-card firmware-summary-card">
        <div>
          <p class="section-kicker">当前节点</p>
          <h4>#{{ selectedNode.nodeId }} {{ describeNode(selectedNode) }}</h4>
        </div>
        <div class="selection-summary-meta">
          <span>设备类型：{{ selectedNode.deviceType || '未识别' }}</span>
          <span>当前固件：{{ selectedNode.firmwareVersion || '-' }}</span>
        </div>
      </div>

      <div class="page-grid firmware-info-grid">
        <section class="page-card accent-card firmware-subcard">
          <div class="section-heading section-heading-tight">
            <div>
              <p class="section-kicker">能力</p>
              <h3>固件升级能力</h3>
            </div>
            <span class="status-pill" :data-tone="capabilities?.firmwareUpgradable ? 'good' : 'bad'">
              {{ capabilities?.firmwareUpgradable ? '支持升级' : '不支持升级' }}
            </span>
          </div>

          <dl v-if="capabilities" class="details-grid firmware-details-grid">
            <div>
              <dt>支持目标</dt>
              <dd>{{ capabilities.firmwareTargets.length ? capabilities.firmwareTargets.join(', ') : '-' }}</dd>
            </div>
            <div>
              <dt>升级期间继续工作</dt>
              <dd>{{ capabilities.continuesToFunction == null ? '-' : (capabilities.continuesToFunction ? '是' : '否') }}</dd>
            </div>
            <div>
              <dt>支持续传</dt>
              <dd>{{ capabilities.supportsResuming == null ? '-' : (capabilities.supportsResuming ? '是' : '否') }}</dd>
            </div>
            <div>
              <dt>支持非安全传输</dt>
              <dd>{{ capabilities.supportsNonSecureTransfer == null ? '-' : (capabilities.supportsNonSecureTransfer ? '是' : '否') }}</dd>
            </div>
          </dl>
          <p v-else class="empty-state">选择节点后，这里会显示设备声明的 OTA 能力。</p>
        </section>

        <section class="page-card firmware-subcard">
          <div class="section-heading section-heading-tight">
            <div>
              <p class="section-kicker">文件</p>
              <h3>固件解析结果</h3>
            </div>
            <span class="status-pill" :data-tone="inspection ? 'good' : 'warn'">
              {{ inspection ? '已解析' : '待上传' }}
            </span>
          </div>

          <dl v-if="inspection" class="details-grid firmware-details-grid">
            <div>
              <dt>原始文件</dt>
              <dd>{{ inspection.sourceFilename }}</dd>
            </div>
            <div>
              <dt>实际固件文件</dt>
              <dd>{{ inspection.firmwareFilename }}</dd>
            </div>
            <div>
              <dt>固件格式</dt>
              <dd>{{ inspection.format }}</dd>
            </div>
            <div>
              <dt>固件大小</dt>
              <dd>{{ formatBytes(inspection.fileSize) }}</dd>
            </div>
            <div>
              <dt>检测到的目标</dt>
              <dd>{{ inspection.detectedTarget == null ? '未检测到' : inspection.detectedTarget }}</dd>
            </div>
          </dl>
          <p v-else class="empty-state">支持直接上传 `.ota`、`.otz`、`.hex`、`.bin` 或包含固件的 ZIP 包。</p>

          <div class="check-list firmware-option-list">
            <label class="check-item">
              <input v-model="resume" type="checkbox" :disabled="!capabilities?.supportsResuming || isRunning" />
              <span>启用续传</span>
            </label>
            <label class="check-item">
              <input v-model="nonSecureTransfer" type="checkbox" :disabled="!capabilities?.supportsNonSecureTransfer || isRunning" />
              <span>使用非安全传输</span>
            </label>
          </div>

          <p v-if="detectedTargetMismatch" class="error-text">
            当前文件检测到的目标与所选目标不一致，请重新选择正确的 Target。
          </p>
        </section>
      </div>

      <section class="page-card firmware-progress-card">
        <div class="section-heading section-heading-tight">
          <div>
            <p class="section-kicker">进度</p>
            <h3>升级状态</h3>
          </div>
          <span class="status-pill" :data-tone="phaseTone(upgradeStatus?.phase)">
            {{ phaseLabel(upgradeStatus?.phase) }}
          </span>
        </div>

        <template v-if="upgradeStatus">
          <div class="firmware-progress-track">
            <div class="firmware-progress-fill" :style="{ width: `${upgradeStatus.progress?.progress ?? 0}%` }"></div>
          </div>

          <dl class="details-grid firmware-details-grid firmware-status-grid">
            <div>
              <dt>升级进度</dt>
              <dd>{{ upgradeStatus.progress?.progress ?? 0 }}%</dd>
            </div>
            <div>
              <dt>分片进度</dt>
              <dd>{{ upgradeStatus.progress ? `${upgradeStatus.progress.sentFragments}/${upgradeStatus.progress.totalFragments}` : '-' }}</dd>
            </div>
            <div>
              <dt>目标位置</dt>
              <dd>{{ upgradeStatus.target }}</dd>
            </div>
            <div>
              <dt>开始时间</dt>
              <dd>{{ formatDateTime(upgradeStatus.startedAt) }}</dd>
            </div>
            <div>
              <dt>完成时间</dt>
              <dd>{{ formatDateTime(upgradeStatus.finishedAt) }}</dd>
            </div>
            <div>
              <dt>结果状态码</dt>
              <dd>{{ upgradeStatus.result?.status ?? '-' }}</dd>
            </div>
          </dl>

          <p v-if="upgradeStatus.error" class="error-text firmware-result-text">{{ upgradeStatus.error }}</p>
          <p v-else class="run-summary firmware-result-text">{{ upgradeStatus.message || '等待升级状态...' }}</p>
        </template>

        <p v-else class="empty-state">开始升级后，这里会持续显示 OTA 进度和最终结果。</p>
      </section>
    </section>
  </div>
</template>

<style scoped>
.firmware-page-grid {
  min-height: 100%;
}

.firmware-card {
  display: grid;
  gap: 18px;
}

.firmware-heading {
  margin-bottom: 0;
}

.firmware-toolbar-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.firmware-file-input {
  padding: 10px 14px;
}

.firmware-status-banner {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid rgba(123, 66, 255, 0.16);
  background: rgba(245, 240, 255, 0.72);
}

.firmware-summary-card {
  align-items: center;
}

.firmware-info-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.firmware-subcard,
.firmware-progress-card {
  padding: 20px;
}

.firmware-details-grid {
  gap: 16px;
}

.firmware-option-list {
  margin-top: 16px;
}

.firmware-progress-track {
  overflow: hidden;
  height: 14px;
  border-radius: 999px;
  background: rgba(92, 57, 181, 0.12);
}

.firmware-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(135deg, var(--accent), var(--accent-deep));
  transition: width 220ms ease;
}

.firmware-status-grid {
  margin-top: 18px;
}

.firmware-result-text {
  margin: 0;
}

@media (max-width: 980px) {
  .firmware-toolbar-grid,
  .firmware-info-grid {
    grid-template-columns: 1fr;
  }
}
</style>

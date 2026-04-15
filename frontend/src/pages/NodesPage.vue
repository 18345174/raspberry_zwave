<script setup lang="ts">
import { ref } from "vue";

import { apiClient } from "../api/client";
import { usePlatformStore } from "../stores/platform";
import type { CommandClassSnapshot, EndpointSnapshot } from "../types";

interface SupportedEndpointResult {
  index: number;
  label?: string;
  commandClasses: CommandClassSnapshot[];
}

interface SupportedCcReadResult {
  commandClasses: CommandClassSnapshot[];
  endpoints: SupportedEndpointResult[];
  readAt: string;
}

const platform = usePlatformStore();

const activeNodeId = ref<number | null>(null);
const loadingNodeId = ref<number | null>(null);
const readResults = ref<Record<number, SupportedCcReadResult>>({});
const readErrors = ref<Record<number, string>>({});
const copyFeedback = ref("");

function getReadResult(nodeId: number): SupportedCcReadResult | undefined {
  return readResults.value[nodeId];
}

function getReadError(nodeId: number): string | undefined {
  return readErrors.value[nodeId];
}

function hasDialogContent(nodeId: number): boolean {
  return activeNodeId.value === nodeId && Boolean(getReadResult(nodeId) || getReadError(nodeId));
}

function closeReadDialog(): void {
  if (loadingNodeId.value != null) {
    return;
  }
  activeNodeId.value = null;
  copyFeedback.value = "";
}

function getActiveNode() {
  return platform.nodes.find((node) => node.nodeId === activeNodeId.value) ?? null;
}

function getActiveReadResult(): SupportedCcReadResult | undefined {
  return activeNodeId.value != null ? getReadResult(activeNodeId.value) : undefined;
}

function formatCommandClass(commandClass: CommandClassSnapshot): string {
  return commandClass.version != undefined
    ? `${commandClass.name} v${commandClass.version}`
    : commandClass.name;
}

function formatCommandClassWithId(commandClass: CommandClassSnapshot): string {
  return `${formatCommandClassId(commandClass.id)} ${formatCommandClass(commandClass)}`;
}

function formatCommandClassId(id: number): string {
  return `0x${id.toString(16).toUpperCase().padStart(2, "0")}`;
}

function formatReadTime(value?: string): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("zh-CN", { hour12: false });
}

function normalizeCommandClasses(commandClasses?: CommandClassSnapshot[], fallbackNames?: string[]): CommandClassSnapshot[] {
  if (commandClasses?.length) {
    return [...commandClasses].sort((left, right) => left.id - right.id);
  }

  return (fallbackNames ?? []).map((name, index) => ({
    id: index,
    name,
  }));
}

function normalizeEndpoints(endpoints: EndpointSnapshot[]): SupportedEndpointResult[] {
  return [...endpoints]
    .map((endpoint) => ({
      index: endpoint.index,
      label: endpoint.label,
      commandClasses: normalizeCommandClasses(endpoint.commandClassDetails, endpoint.commandClasses),
    }))
    .sort((left, right) => left.index - right.index);
}

function buildCopyText(nodeId: number, result: SupportedCcReadResult): string {
  const node = platform.nodes.find((item) => item.nodeId === nodeId);
  const lines = [
    "====== Supported CC ======",
    `Node: #${nodeId} ${node?.name || node?.product || ""}`.trim(),
    `Read At: ${formatReadTime(result.readAt)}`,
    "",
    "All Command Classes:",
  ];

  if (result.commandClasses.length === 0) {
    lines.push("- (empty)");
  } else {
    lines.push(...result.commandClasses.map((item) => `- ${formatCommandClassWithId(item)}`));
  }

  for (const endpoint of result.endpoints) {
    lines.push("");
    lines.push(`Endpoint ${endpoint.index}${endpoint.label ? ` - ${endpoint.label}` : ""}:`);

    if (endpoint.commandClasses.length === 0) {
      lines.push("- (empty)");
      continue;
    }

    lines.push(...endpoint.commandClasses.map((item) => `- ${formatCommandClassWithId(item)}`));
  }

  return lines.join("\n");
}

async function copySupportedCommandClasses(nodeId: number): Promise<void> {
  const result = getReadResult(nodeId);
  if (!result) {
    copyFeedback.value = "没有可复制的 CC 结果";
    return;
  }

  const text = buildCopyText(nodeId, result);

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.setAttribute("readonly", "true");
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
    }

    copyFeedback.value = "已复制到剪贴板";
  } catch {
    copyFeedback.value = "复制失败，请手动选择复制";
  }
}

async function readSupportedCommandClasses(nodeId: number): Promise<void> {
  activeNodeId.value = nodeId;
  loadingNodeId.value = nodeId;
  copyFeedback.value = "";
  readErrors.value = {
    ...readErrors.value,
    [nodeId]: "",
  };

  try {
    const detail = await apiClient.refreshNode(nodeId);
    readResults.value = {
      ...readResults.value,
      [nodeId]: {
        commandClasses: normalizeCommandClasses(detail.commandClassDetails, detail.commandClasses),
        endpoints: normalizeEndpoints(detail.endpoints),
        readAt: new Date().toISOString(),
      },
    };

    await platform.refreshNodes().catch(() => {
      // Keep the freshly read result visible even if the summary refresh fails.
    });
  } catch (error) {
    readErrors.value = {
      ...readErrors.value,
      [nodeId]: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (loadingNodeId.value === nodeId) {
      loadingNodeId.value = null;
    }
  }
}
</script>

<template>
  <div class="page-grid page-grid-single">
    <section class="page-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">设备清单</p>
          <h3>设备列表</h3>
        </div>
        <button class="ghost-button" @click="platform.refreshNodes">刷新</button>
      </div>

      <div class="device-table-wrap">
        <table class="device-table">
          <thead>
            <tr>
              <th>节点 ID</th>
              <th>名称</th>
              <th>设备类型</th>
              <th>制造商</th>
              <th>产品</th>
              <th>安全</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody v-if="platform.nodes.length > 0">
            <tr v-for="node in platform.nodes" :key="node.nodeId">
              <td>#{{ node.nodeId }}</td>
              <td>{{ node.name || '-' }}</td>
              <td>{{ node.deviceType || '-' }}</td>
              <td>{{ node.manufacturer || '-' }}</td>
              <td>{{ node.product || '-' }}</td>
              <td>{{ node.isSecure ? '安全' : '非安全' }}</td>
              <td>{{ node.status || node.interviewStage || '未知状态' }}</td>
              <td class="cc-action-cell">
                <button
                  class="ghost-button cc-read-button"
                  :disabled="loadingNodeId === node.nodeId"
                  @click="readSupportedCommandClasses(node.nodeId)"
                >
                  {{ loadingNodeId === node.nodeId ? '读取中...' : '读取支持 CC' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="platform.nodes.length === 0" class="empty-state">当前没有设备，点击右上角“刷新”重新获取列表。</p>
      </div>
    </section>

    <div
      v-if="activeNodeId && (loadingNodeId === activeNodeId || hasDialogContent(activeNodeId))"
      class="cc-dialog-backdrop"
      @click.self="closeReadDialog"
    >
      <div class="cc-dialog">
        <div class="cc-dialog-header">
          <div>
            <p class="section-kicker">支持 CC</p>
            <h4 class="cc-dialog-title">
              节点 #{{ getActiveNode()?.nodeId ?? activeNodeId }}
              {{ getActiveNode()?.name || getActiveNode()?.product || '' }}
            </h4>
          </div>

          <div class="button-row">
            <button
              class="ghost-button"
              :disabled="loadingNodeId != null || !getActiveReadResult()"
              @click="copySupportedCommandClasses(activeNodeId)"
            >
              复制 CC 列表
            </button>
            <button class="ghost-button" :disabled="loadingNodeId != null" @click="closeReadDialog">关闭</button>
          </div>
        </div>

        <p v-if="copyFeedback" class="cc-copy-feedback">{{ copyFeedback }}</p>

        <div v-if="loadingNodeId === activeNodeId" class="cc-result-card">
          <p class="cc-result-title">正在读取设备支持的 CC...</p>
          <p class="cc-read-meta">请稍候，系统正在刷新该节点的 interview 信息。</p>
        </div>

        <div v-else-if="getReadError(activeNodeId)" class="cc-result-card cc-result-error">
          <p class="cc-result-title">读取失败</p>
          <p class="cc-read-meta">{{ getReadError(activeNodeId) }}</p>
        </div>

        <template v-else-if="getActiveReadResult()">
          <div class="cc-result-card">
            <div class="cc-result-heading">
              <div>
                <p class="cc-result-title">节点级汇总</p>
                <p class="cc-read-meta">最近读取：{{ formatReadTime(getActiveReadResult()?.readAt) }}</p>
              </div>
              <span class="cc-count">共 {{ getActiveReadResult()?.commandClasses.length ?? 0 }} 个</span>
            </div>

            <div v-if="(getActiveReadResult()?.commandClasses.length ?? 0) > 0" class="cc-chip-list">
              <span
                v-for="commandClass in getActiveReadResult()?.commandClasses ?? []"
                :key="`${activeNodeId}-${commandClass.id}-${commandClass.name}`"
                class="cc-chip"
              >
                {{ formatCommandClassWithId(commandClass) }}
              </span>
            </div>

            <p v-else class="empty-state cc-empty-tip">未读取到支持的 CC，可能设备尚未完成 interview。</p>
          </div>

          <div class="cc-endpoint-grid">
            <section
              v-for="endpoint in getActiveReadResult()?.endpoints ?? []"
              :key="`${activeNodeId}-endpoint-${endpoint.index}`"
              class="cc-endpoint-card"
            >
              <div class="cc-endpoint-header">
                <div>
                  <p class="section-kicker">Endpoint {{ endpoint.index }}</p>
                  <h5 class="cc-endpoint-title">{{ endpoint.label || '未命名 Endpoint' }}</h5>
                </div>
                <span class="cc-count">共 {{ endpoint.commandClasses.length }} 个</span>
              </div>

              <div v-if="endpoint.commandClasses.length > 0" class="cc-chip-list">
                <span
                  v-for="commandClass in endpoint.commandClasses"
                  :key="`${activeNodeId}-${endpoint.index}-${commandClass.id}-${commandClass.name}`"
                  class="cc-chip"
                >
                  {{ formatCommandClassWithId(commandClass) }}
                </span>
              </div>

              <p v-else class="empty-state cc-empty-tip">该 Endpoint 未读取到支持的 CC。</p>
            </section>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cc-action-cell {
  width: 140px;
}

.cc-read-button {
  min-height: 36px;
  padding: 0 14px;
}

.cc-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(112, 84, 172, 0.18);
  backdrop-filter: blur(10px);
}

.cc-dialog {
  width: min(900px, 100%);
  max-height: min(84vh, 920px);
  overflow: auto;
  display: grid;
  gap: 16px;
  padding: 24px;
  border: 1px solid rgba(143, 117, 201, 0.18);
  border-radius: 28px;
  background: linear-gradient(180deg, rgba(253, 250, 255, 0.99), rgba(241, 232, 255, 0.95));
  box-shadow: 0 26px 64px rgba(100, 74, 156, 0.22);
}

.cc-dialog-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.cc-dialog-title,
.cc-endpoint-title {
  margin: 0;
}

.cc-copy-feedback {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid rgba(123, 66, 255, 0.16);
  border-radius: 14px;
  background: rgba(245, 240, 255, 0.72);
  color: #5b42a8;
}

.cc-result-card,
.cc-endpoint-card {
  display: grid;
  gap: 14px;
  padding: 16px 18px;
  border: 1px solid rgba(123, 66, 255, 0.12);
  border-radius: 16px;
  background: rgba(250, 247, 255, 0.92);
}

.cc-result-error {
  border-color: rgba(207, 117, 185, 0.24);
  background: rgba(255, 246, 252, 0.92);
}

.cc-result-heading,
.cc-endpoint-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.cc-result-title,
.cc-read-meta {
  margin: 0;
}

.cc-result-title {
  font-weight: 700;
}

.cc-read-meta {
  color: var(--muted);
}

.cc-count {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  background: rgba(183, 156, 255, 0.18);
  color: #5b42a8;
  font-size: 0.82rem;
  font-weight: 700;
}

.cc-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.cc-chip {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.86);
  border: 1px solid rgba(143, 117, 201, 0.14);
  font-size: 0.88rem;
}

.cc-endpoint-grid {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.cc-empty-tip {
  margin: 0;
}

@media (max-width: 720px) {
  .cc-dialog {
    padding: 18px;
  }

  .cc-dialog-header,
  .cc-result-heading,
  .cc-endpoint-header {
    flex-direction: column;
  }

  .cc-endpoint-grid {
    grid-template-columns: 1fr;
  }
}
</style>

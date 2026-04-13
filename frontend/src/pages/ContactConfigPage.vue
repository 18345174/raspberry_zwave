<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { apiClient } from "../api/client";
import { usePlatformStore } from "../stores/platform";
import type { ContactConfigRow, NodeSummary } from "../types";

const platform = usePlatformStore();

const selectedNodeId = ref<number | null>(null);
const rows = ref<ContactConfigRow[]>([]);
const loading = ref(false);
const statusMessage = ref("请选择门磁节点");

const candidateNodes = computed(() => {
  return [...platform.nodes]
    .filter((node) => node.nodeId !== platform.status.controllerId)
    .sort((left, right) => left.nodeId - right.nodeId);
});

const selectedNode = computed(() => {
  return candidateNodes.value.find((node) => node.nodeId === selectedNodeId.value) ?? null;
});

function describeNode(node: NodeSummary): string {
  return node.product || node.name || node.manufacturer || `节点 ${node.nodeId}`;
}

function hasRows(): boolean {
  return rows.value.length > 0;
}

watch(
  candidateNodes,
  (nodes) => {
    if (!nodes.length) {
      selectedNodeId.value = null;
      rows.value = [];
      statusMessage.value = "当前没有可读取的节点";
      return;
    }

    if (!nodes.some((node) => node.nodeId === selectedNodeId.value)) {
      selectedNodeId.value = nodes[0]?.nodeId ?? null;
      rows.value = [];
      statusMessage.value = "请选择节点并点击“读取配置”";
    }
  },
  { immediate: true },
);

async function refreshNodeList(): Promise<void> {
  await platform.refreshNodes();
}

async function fetchContactConfig(): Promise<void> {
  if (!selectedNodeId.value) {
    statusMessage.value = "请先选择节点";
    return;
  }

  loading.value = true;
  rows.value = [];
  statusMessage.value = "正在读取门磁配置，请稍候...";

  try {
    const response = await apiClient.getContactConfig(selectedNodeId.value);
    rows.value = response.items;
    statusMessage.value = rows.value.length
      ? `共读取 ${rows.value.length} 个门磁配置参数（节点 ${selectedNodeId.value}）`
      : "未读取到参数 x/y/z，检查设备是否支持配置命令类。";
  } catch (error) {
    statusMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

function exportRows(): void {
  if (!selectedNode.value || !rows.value.length) {
    return;
  }

  const lines = [
    "====== 门磁配置导出 ======",
    `节点: #${selectedNode.value.nodeId} ${describeNode(selectedNode.value)}`,
    "",
  ];

  for (const row of rows.value) {
    lines.push(row.label);
    lines.push(`  显示值: ${row.display || "-"}`);
    lines.push(`  原始值: ${row.raw || "-"}`);
    if (row.range) {
      lines.push(`  说明: ${row.range}`);
    }
    lines.push("");
  }

  lines.push("====== 导出结束 ======");

  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `contact-config-node-${selectedNode.value.nodeId}.txt`;
  link.click();
  window.URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="page-grid page-grid-single contact-page-grid">
    <section class="page-card contact-card">
      <div class="section-heading section-heading-tight">
        <div>
          <p class="section-kicker">门磁配置</p>
          <h3>读取门磁配置参数</h3>
        </div>

        <div class="button-row">
          <button class="ghost-button" @click="refreshNodeList">刷新节点</button>
          <button class="primary-button" :disabled="loading || !selectedNodeId" @click="fetchContactConfig">读取配置</button>
          <button class="ghost-button" :disabled="!hasRows()" @click="exportRows">导出结果</button>
        </div>
      </div>

      <div class="toolbar-row">
        <label class="field-stack field-stack-wide">
          <span>节点列表</span>
          <select v-model="selectedNodeId" class="text-input" :disabled="loading || !candidateNodes.length">
            <option :value="null">请选择节点</option>
            <option v-for="node in candidateNodes" :key="node.nodeId" :value="node.nodeId">
              #{{ node.nodeId }} {{ describeNode(node) }}
            </option>
          </select>
        </label>
      </div>

      <p class="status-banner">{{ statusMessage }}</p>

      <div v-if="selectedNode" class="selection-summary-card">
        <div>
          <p class="section-kicker">当前节点</p>
          <h4>#{{ selectedNode.nodeId }} {{ describeNode(selectedNode) }}</h4>
        </div>
        <div class="selection-summary-meta">
          <span>设备类型：{{ selectedNode.deviceType || '未识别' }}</span>
          <span>制造商：{{ selectedNode.manufacturer || '-' }}</span>
        </div>
      </div>

      <div v-if="rows.length" class="config-table">
        <div class="config-table-row config-table-head">
          <span>参数标签</span>
          <span>当前值</span>
          <span>原始值</span>
          <span>说明 / 范围</span>
        </div>

        <div v-for="row in rows" :key="row.parameter" class="config-table-row">
          <span>{{ row.label }}</span>
          <span>{{ row.display || '-' }}</span>
          <span>{{ row.raw || '-' }}</span>
          <span>{{ row.range || '-' }}</span>
        </div>
      </div>

      <p v-else class="empty-state">读取完成后，这里会显示参数 10 / 11 / 12 的当前配置。</p>
    </section>
  </div>
</template>

<style scoped>
.contact-page-grid {
  min-height: 100%;
}

.contact-card {
  display: grid;
  gap: 18px;
}

.section-heading-tight {
  margin-bottom: 0;
}

.toolbar-row {
  display: grid;
  grid-template-columns: minmax(260px, 420px);
}

.field-stack-wide {
  margin: 0;
}

.status-banner {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid rgba(123, 66, 255, 0.16);
  background: rgba(245, 240, 255, 0.72);
  color: var(--muted);
}

.selection-summary-card,
.config-table-row {
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.74);
}

.selection-summary-card {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  padding: 18px;
}

.selection-summary-card h4,
.selection-summary-card p {
  margin: 0;
}

.selection-summary-meta {
  display: grid;
  gap: 6px;
  color: var(--muted);
  text-align: right;
}

.config-table {
  display: grid;
  gap: 10px;
}

.config-table-row {
  display: grid;
  grid-template-columns: minmax(200px, 1.3fr) minmax(140px, 0.9fr) minmax(120px, 0.8fr) minmax(220px, 1.4fr);
  gap: 14px;
  align-items: center;
  padding: 16px 18px;
}

.config-table-head {
  background: rgba(240, 233, 255, 0.8);
  color: var(--muted);
  font-size: 0.86rem;
  font-weight: 700;
}

@media (max-width: 720px) {
  .selection-summary-card {
    flex-direction: column;
    align-items: flex-start;
  }

  .selection-summary-meta {
    text-align: left;
  }

  .toolbar-row,
  .config-table-row {
    grid-template-columns: 1fr;
  }

  .config-table-head {
    display: none;
  }
}
</style>

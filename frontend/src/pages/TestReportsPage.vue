<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { apiClient } from "../api/client";
import { usePlatformStore } from "../stores/platform";
import type { NodeSummary, TestReportSummary } from "../types";
import { downloadTextFile, downloadXlsxFromCsv } from "../utils/report-files";

const platform = usePlatformStore();

const selectedNodeFilter = ref<number | "all">("all");
const reports = ref<TestReportSummary[]>([]);
const loading = ref(false);
const actionBusy = ref(false);
const statusMessage = ref("");

const candidateNodes = computed(() => {
  return [...platform.nodes]
    .filter((node) => node.nodeId !== platform.status.controllerId && node.deviceType !== "Controller")
    .sort((left, right) => left.nodeId - right.nodeId);
});

function describeNode(node: NodeSummary): string {
  return node.product || node.name || node.manufacturer || `节点 ${node.nodeId}`;
}

function describeNodeById(nodeId: number): string {
  const node = candidateNodes.value.find((item) => item.nodeId === nodeId);
  return node ? describeNode(node) : `节点 ${nodeId}`;
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

function buildReportBaseName(report: TestReportSummary): string {
  return `zwave-test-report-node-${report.nodeId}-${report.id}`;
}

async function loadReports(): Promise<void> {
  loading.value = true;
  statusMessage.value = "";

  try {
    const response = await apiClient.listReports(selectedNodeFilter.value === "all" ? undefined : selectedNodeFilter.value);
    reports.value = response.items;
    statusMessage.value = response.items.length
      ? `共加载 ${response.items.length} 份测试报告`
      : "当前筛选条件下还没有测试报告";
  } catch (error) {
    statusMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

async function downloadReport(report: TestReportSummary, format: "html" | "xlsx"): Promise<void> {
  actionBusy.value = true;
  statusMessage.value = "";

  try {
    const fullReport = await apiClient.getReport(report.id);

    if (format === "html") {
      downloadTextFile(fullReport.htmlContent, `${buildReportBaseName(report)}.html`, "text/html;charset=utf-8");
    } else {
      downloadXlsxFromCsv(fullReport.csvContent, `${buildReportBaseName(report)}.xlsx`, "Test Report");
    }

    statusMessage.value = `已下载报告：${report.title}（${format === "html" ? "HTML" : "XLSX"}）`;
  } catch (error) {
    statusMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    actionBusy.value = false;
  }
}

watch(selectedNodeFilter, async () => {
  await loadReports();
}, { immediate: true });
</script>

<template>
  <div class="page-grid page-grid-single reports-page-grid">
    <section class="page-card reports-shell-card">
      <div class="section-heading section-heading-tight">
        <div>
          <p class="section-kicker">测试报告</p>
          <h3>历史报告列表</h3>
        </div>

        <div class="button-row">
          <button class="ghost-button" :disabled="loading || actionBusy" @click="loadReports">刷新报告</button>
        </div>
      </div>

      <div class="toolbar-row">
        <label class="field-stack field-stack-wide">
          <span>节点筛选</span>
          <select v-model="selectedNodeFilter" class="text-input" :disabled="loading || actionBusy">
            <option value="all">全部节点</option>
            <option v-for="node in candidateNodes" :key="node.nodeId" :value="node.nodeId">
              #{{ node.nodeId }} {{ describeNode(node) }}
            </option>
          </select>
        </label>
      </div>

      <p class="status-banner">{{ statusMessage || '可在这里统一查看所有节点的测试报告，并下载 HTML / XLSX。' }}</p>

      <div v-if="loading" class="empty-state">正在加载测试报告...</div>

      <div v-else-if="reports.length" class="report-list">
        <article v-for="report in reports" :key="report.id" class="report-item">
          <div class="report-item-main">
            <div>
              <strong>{{ report.title }}</strong>
              <p class="report-item-meta">
                节点：#{{ report.nodeId }} {{ describeNodeById(report.nodeId) }}
              </p>
              <p class="report-item-meta">
                报告 ID：{{ report.id }} · 生成时间：{{ formatTimestamp(report.createdAt) }}
              </p>
            </div>
            <div class="report-item-side">
              <span class="status-pill" :data-tone="report.status.includes('通过') ? 'good' : report.status.includes('失败') || report.status.includes('取消') ? 'bad' : undefined">
                {{ report.status }}
              </span>
              <span class="report-item-meta">来源任务：{{ report.sourceRunIds.length }} 个</span>
            </div>
          </div>

          <div class="button-row">
            <button class="ghost-button compact-button" :disabled="actionBusy" @click="downloadReport(report, 'html')">
              下载 HTML
            </button>
            <button class="ghost-button compact-button" :disabled="actionBusy" @click="downloadReport(report, 'xlsx')">
              下载 XLSX
            </button>
          </div>
        </article>
      </div>

      <p v-else class="empty-state">还没有测试报告。完成测试后点击“生成测试报告”即可在这里查看。</p>
    </section>
  </div>
</template>

<style scoped>
.reports-page-grid {
  min-height: 100%;
}

.reports-shell-card {
  display: grid;
  gap: 18px;
}

.status-banner {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid rgba(92, 57, 181, 0.18);
  background: rgba(244, 239, 255, 0.82);
  color: var(--accent-deep);
}

.report-list {
  display: grid;
  gap: 14px;
}

.report-item {
  display: grid;
  gap: 16px;
  padding: 18px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.78);
}

.report-item-main {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: start;
}

.report-item-meta {
  margin: 6px 0 0;
  color: var(--muted);
}

.report-item-side {
  display: grid;
  gap: 8px;
  justify-items: end;
}
</style>

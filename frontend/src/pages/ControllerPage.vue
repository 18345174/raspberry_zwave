<script setup lang="ts">
import { computed, ref, watch } from "vue";

import StatusPill from "../components/StatusPill.vue";
import { usePlatformStore } from "../stores/platform";
import { translateDriverPhase, translatePortKind } from "../utils/ui-text";

const platform = usePlatformStore();

const draftPortPath = ref("");
const selectedPort = computed(() => platform.ports.find((item) => item.path === platform.selectedPortPath));
const draftPort = computed(() => platform.ports.find((item) => item.path === draftPortPath.value));
const isBusy = computed(() => platform.status.phase === "connecting" || platform.status.phase === "disconnecting");
const canConnect = computed(() => Boolean(platform.selectedPortPath) && !isBusy.value && platform.status.phase !== "ready");
const canReconnect = computed(() => Boolean(platform.selectedPortPath) && !isBusy.value);
const canDisconnect = computed(() => !isBusy.value && platform.status.phase !== "idle");

watch(
  () => platform.selectedPortPath,
  (value) => {
    draftPortPath.value = value;
  },
  { immediate: true },
);

async function handleRefresh(): Promise<void> {
  await platform.refreshPorts();
}

async function handleSave(): Promise<void> {
  if (!draftPort.value) {
    return;
  }
  await platform.saveSelectedPort(draftPort.value.path, draftPort.value.stablePath);
}
</script>

<template>
  <div class="page-grid controller-page-grid">
    <section class="page-card accent-card controller-selection-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">串口发现</p>
          <h3>控制器与运行状态</h3>
        </div>
        <button class="ghost-button" @click="handleRefresh">重新扫描</button>
      </div>

      <div class="field-stack">
        <span>控制器串口</span>
        <select v-model="draftPortPath" class="text-input">
          <option value="">请选择串口</option>
          <option v-for="port in platform.ports" :key="port.path" :value="port.path">
            {{ port.stablePath || port.path }}（{{ translatePortKind(port.isCandidateController) }}）
          </option>
        </select>
      </div>

      <div v-if="draftPort" class="details-grid">
        <div>
          <dt>稳定路径</dt>
          <dd>{{ draftPort.stablePath || '-' }}</dd>
        </div>
        <div>
          <dt>设备类型</dt>
          <dd>{{ translatePortKind(draftPort.isCandidateController) }}</dd>
        </div>
        <div>
          <dt>厂商</dt>
          <dd>{{ draftPort.manufacturer || '-' }}</dd>
        </div>
        <div>
          <dt>VID/PID</dt>
          <dd>{{ draftPort.vendorId || '-' }} / {{ draftPort.productId || '-' }}</dd>
        </div>
      </div>

      <div class="button-row">
        <button class="primary-button" :disabled="!draftPort" @click="handleSave">
          {{ draftPortPath && draftPortPath === platform.selectedPortPath ? '已选择当前串口' : '保存串口选择' }}
        </button>
      </div>
    </section>

    <section class="page-card controller-status-card">
      <div class="section-heading section-heading-tight">
        <div>
          <p class="section-kicker">驱动生命周期</p>
          <h3>运行状态</h3>
        </div>
        <StatusPill :label="translateDriverPhase(platform.status.phase)" :tone="platform.status.phase === 'ready' ? 'good' : platform.status.phase === 'error' ? 'bad' : 'warn'" />
      </div>

      <p class="status-intro">
        串口选择保存在左侧，右侧面板聚焦当前连接状态与常用操作，让宽屏下的信息利用更充分。
      </p>

      <dl class="details-grid">
        <div>
          <dt>已选串口</dt>
          <dd>{{ selectedPort?.stablePath || platform.selectedPortPath || '-' }}</dd>
        </div>
        <div>
          <dt>连接串口</dt>
          <dd>{{ platform.status.connectedPortPath || '-' }}</dd>
        </div>
        <div>
          <dt>家庭 ID</dt>
          <dd>{{ platform.status.homeId || '-' }}</dd>
        </div>
        <div>
          <dt>控制器 ID</dt>
          <dd>{{ platform.status.controllerId || '-' }}</dd>
        </div>
      </dl>

      <div class="button-row">
        <button class="primary-button" :disabled="!canConnect" @click="platform.connectDriver">
          {{ platform.status.phase === "connecting" ? "连接中..." : "连接" }}
        </button>
        <button class="ghost-button" :disabled="!canReconnect" @click="platform.reconnectDriver">重连</button>
        <button class="ghost-button danger" :disabled="!canDisconnect" @click="platform.disconnectDriver">断开</button>
      </div>

      <p v-if="platform.status.lastError" class="error-text">{{ platform.status.lastError }}</p>
      <p v-else-if="platform.status.phase === 'connecting'" class="port-meta">驱动已启动，正在等待控制器完成就绪。</p>
      <p v-else class="port-meta">若控制器未进入就绪状态，可先确认左侧串口选择，再尝试重连。</p>
    </section>
  </div>
</template>

<style scoped>
.controller-page-grid {
  grid-template-columns: minmax(360px, 1.1fr) minmax(320px, 0.9fr);
  align-items: start;
}

.controller-selection-card,
.controller-status-card {
  display: grid;
  gap: 18px;
}

.section-heading-tight {
  margin-bottom: 0;
}

.status-intro {
  margin: 0;
  color: var(--muted);
}

@media (max-width: 1100px) {
  .controller-page-grid {
    grid-template-columns: 1fr;
  }
}
</style>

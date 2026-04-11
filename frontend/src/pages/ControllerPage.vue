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
  <div class="page-grid page-grid-single">
    <section class="page-card accent-card">
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

      <div class="section-heading controller-status-heading">
        <div>
          <p class="section-kicker">驱动生命周期</p>
          <h3>运行状态</h3>
        </div>
        <StatusPill :label="translateDriverPhase(platform.status.phase)" :tone="platform.status.phase === 'ready' ? 'good' : platform.status.phase === 'error' ? 'bad' : 'warn'" />
      </div>

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
    </section>
  </div>
</template>

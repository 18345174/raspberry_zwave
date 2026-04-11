<script setup lang="ts">
import { computed } from "vue";

import StatusPill from "../components/StatusPill.vue";
import { usePlatformStore } from "../stores/platform";
import { translateDriverPhase, translatePortKind } from "../utils/ui-text";

const platform = usePlatformStore();

const selectedPort = computed(() => platform.ports.find((item) => item.path === platform.selectedPortPath));
const isBusy = computed(() => platform.status.phase === "connecting" || platform.status.phase === "disconnecting");
const canConnect = computed(() => Boolean(platform.selectedPortPath) && !isBusy.value && platform.status.phase !== "ready");
const canReconnect = computed(() => Boolean(platform.selectedPortPath) && !isBusy.value);
const canDisconnect = computed(() => !isBusy.value && platform.status.phase !== "idle");

async function handleRefresh(): Promise<void> {
  await platform.refreshPorts();
}

async function handleSave(path: string, stablePath?: string): Promise<void> {
  await platform.saveSelectedPort(path, stablePath);
}
</script>

<template>
  <div class="page-grid">
    <section class="page-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">串口发现</p>
          <h3>控制器选择与连接</h3>
        </div>
        <button class="ghost-button" @click="handleRefresh">重新扫描</button>
      </div>

      <div class="port-grid">
        <article v-for="port in platform.ports" :key="port.path" class="port-card" :data-active="platform.selectedPortPath === port.path">
          <div class="port-title-row">
            <h4>{{ port.stablePath || port.path }}</h4>
            <StatusPill :label="translatePortKind(port.isCandidateController)" :tone="port.isCandidateController ? 'good' : 'neutral'" />
          </div>
          <p class="port-meta">实际路径：{{ port.path }}</p>
          <p class="port-meta">VID/PID：{{ port.vendorId || '-' }} / {{ port.productId || '-' }}</p>
          <button class="primary-button" @click="handleSave(port.path, port.stablePath)">
            {{ platform.selectedPortPath === port.path ? '已选择' : '选择此控制器' }}
          </button>
        </article>
      </div>
    </section>

    <section class="page-card accent-card">
      <div class="section-heading">
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

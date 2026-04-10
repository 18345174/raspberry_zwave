<script setup lang="ts">
import { reactive } from "vue";

import { apiClient } from "../api/client";
import { usePlatformStore } from "../stores/platform";

const platform = usePlatformStore();
const form = reactive({
  key: "",
  value: "",
  apiToken: typeof window !== "undefined" ? window.localStorage.getItem("zwaveApiToken") ?? "" : "",
});

async function saveConfig(): Promise<void> {
  if (!form.key) {
    return;
  }
  await apiClient.updateConfig({ [form.key]: form.value });
  await platform.bootstrap();
}

async function saveToken(): Promise<void> {
  window.localStorage.setItem("zwaveApiToken", form.apiToken.trim());
  await platform.bootstrap();
}
</script>

<template>
  <div class="page-grid">
    <section class="page-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">Service Health</p>
          <h3>系统状态</h3>
        </div>
      </div>

      <dl class="details-grid" v-if="platform.health">
        <div>
          <dt>Version</dt>
          <dd>{{ platform.health.version }}</dd>
        </div>
        <div>
          <dt>Uptime</dt>
          <dd>{{ platform.health.uptimeSec }} sec</dd>
        </div>
        <div>
          <dt>WebSocket Clients</dt>
          <dd>{{ platform.health.activeWebSocketClients }}</dd>
        </div>
        <div>
          <dt>Active Run</dt>
          <dd>{{ platform.health.activeTestRunId || '-' }}</dd>
        </div>
      </dl>
    </section>

    <section class="page-card accent-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">Config Surface</p>
          <h3>系统配置</h3>
        </div>
      </div>

      <div class="field-stack">
        <input v-model="form.key" class="text-input" placeholder="config key" />
        <input v-model="form.value" class="text-input" placeholder="config value" />
        <button class="primary-button" @click="saveConfig">写入配置</button>
      </div>

      <div class="field-stack">
        <input v-model="form.apiToken" class="text-input" placeholder="browser API token" />
        <button class="ghost-button" @click="saveToken">保存浏览器 Token</button>
        <button class="ghost-button danger" @click="platform.logout">注销登录会话</button>
      </div>

      <pre class="code-block">{{ JSON.stringify(platform.authSession, null, 2) }}</pre>

      <pre class="code-block">{{ JSON.stringify(platform.configItems, null, 2) }}</pre>
    </section>
  </div>
</template>

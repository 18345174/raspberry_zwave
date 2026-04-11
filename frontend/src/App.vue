<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";

import MetricCard from "./components/MetricCard.vue";
import StatusPill from "./components/StatusPill.vue";
import { usePlatformStore } from "./stores/platform";
import { translateDriverPhase, translateRunStatus, translateWsState } from "./utils/ui-text";

const platform = usePlatformStore();
const route = useRoute();
const router = useRouter();

const navItems = [
  { to: "/controller", label: "控制器" },
  { to: "/inclusion", label: "入排网" },
  { to: "/nodes", label: "节点" },
  { to: "/tests", label: "测试" },
  { to: "/system", label: "系统" },
];

const isLoginRoute = computed(() => route.path === "/login");

const statusTone = computed(() => {
  switch (platform.status.phase) {
    case "ready":
      return "good";
    case "connecting":
    case "disconnecting":
      return "warn";
    case "error":
      return "bad";
    default:
      return "neutral";
  }
});

onMounted(async () => {
  await platform.bootstrap();
  syncRouteWithAuth();
});

watch(
  () => [platform.authSession.isAuthenticated, route.path],
  () => {
    syncRouteWithAuth();
  },
);

function syncRouteWithAuth(): void {
  if (!platform.authSession.isAuthenticated && route.path !== "/login") {
    void router.replace("/login");
    return;
  }

  if (platform.authSession.isAuthenticated && route.path === "/login") {
    void router.replace("/controller");
  }
}
</script>

<template>
  <div v-if="isLoginRoute" class="auth-shell">
    <RouterView />
  </div>

  <div v-else class="shell">
    <aside class="shell-sidebar">
      <h1 class="sidebar-title">Z-Wave 测试平台</h1>

      <nav class="sidebar-nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="sidebar-link"
          :data-active="route.path === item.to"
        >
          {{ item.label }}
        </RouterLink>
      </nav>

      <div class="sidebar-status">
        <StatusPill :label="translateDriverPhase(platform.status.phase)" :tone="statusTone" />
        <span class="sidebar-ws">
          {{ platform.authSession.isAuthenticated ? `用户：${platform.authSession.username}` : "访客" }} / WebSocket：{{ translateWsState(platform.wsState) }}
        </span>
      </div>

      <button class="ghost-button sidebar-logout" @click="platform.logout">退出登录</button>
    </aside>

    <main class="shell-main">
      <section class="hero-panel">
        <div>
          <p class="hero-kicker">工厂级测试台面</p>
          <h2>树莓派上的 Z-Wave 测试控制台</h2>
          <p class="hero-copy">
            以单实例 Driver、单任务测试引擎和稳定串口路径为基础，符合架构文档约束。
          </p>
        </div>
        <div class="hero-metrics">
          <MetricCard eyebrow="驱动" title="运行状态" :value="translateDriverPhase(platform.status.phase)" :note="platform.status.connectedPortPath || '未连接串口'" />
          <MetricCard eyebrow="清单" title="节点数量" :value="String(platform.nodes.length)" note="来自服务端节点快照" />
          <MetricCard eyebrow="执行器" title="最近任务" :value="translateRunStatus(platform.latestRun?.status || 'idle')" :note="platform.latestRun?.id || '暂无测试记录'" />
        </div>
      </section>

      <section class="content-panel">
        <p v-if="platform.errorMessage" class="error-text">
          {{ platform.errorMessage }}
        </p>
        <RouterView />
      </section>

      <section class="notification-strip">
        <article v-for="item in platform.notifications" :key="item.id" class="notification-card">
          <p>{{ item.title }}</p>
          <span>{{ item.body }}</span>
        </article>
      </section>
    </main>
  </div>
</template>

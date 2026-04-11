<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";

import MetricCard from "./components/MetricCard.vue";
import { usePlatformStore } from "./stores/platform";
import { translateDriverPhase, translateRunStatus } from "./utils/ui-text";

const platform = usePlatformStore();
const route = useRoute();
const router = useRouter();

const navItems = [
  { to: "/controller", label: "控制器" },
  { to: "/inclusion", label: "添加/删除设备" },
  { to: "/nodes", label: "节点" },
  { to: "/tests", label: "测试" },
  { to: "/system", label: "系统" },
];

const isLoginRoute = computed(() => route.path === "/login");
const currentPageTitle = computed(() => navItems.find((item) => item.to === route.path)?.label ?? "控制台");

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
      <div class="sidebar-brand">
        <h1 class="sidebar-title">Z-Wave 测试平台</h1>
      </div>

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

      <button class="ghost-button sidebar-logout" @click="platform.logout">退出登录</button>
    </aside>

    <main class="shell-main">
      <section class="page-header">
        <h2>{{ currentPageTitle }}</h2>
      </section>

      <section class="summary-strip">
        <MetricCard compact eyebrow="驱动" title="运行状态" :value="translateDriverPhase(platform.status.phase)" :note="platform.status.connectedPortPath || '未连接串口'" />
        <MetricCard compact eyebrow="清单" title="节点数量" :value="String(platform.nodes.length)" note="来自服务端节点快照" />
        <MetricCard compact eyebrow="执行器" title="最近任务" :value="translateRunStatus(platform.latestRun?.status || 'idle')" :note="platform.latestRun?.id || '暂无测试记录'" />
      </section>

      <section class="content-panel">
        <RouterView />
      </section>
    </main>
  </div>
</template>

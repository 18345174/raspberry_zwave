<script setup lang="ts">
import { usePlatformStore } from "../stores/platform";

const platform = usePlatformStore();
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

      <div class="list-column">
        <article v-for="node in platform.nodes" :key="node.nodeId" class="list-card">
          <div>
            <strong>#{{ node.nodeId }} {{ node.product || node.name || '未命名节点' }}</strong>
            <p>{{ node.manufacturer || '未知厂商' }}</p>
          </div>
          <span>{{ node.status || node.interviewStage || '未知状态' }}</span>
        </article>
        <p v-if="platform.nodes.length === 0" class="empty-state">当前没有设备，点击右上角“刷新”重新获取列表。</p>
      </div>
    </section>
  </div>
</template>

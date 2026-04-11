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
            </tr>
          </tbody>
        </table>
        <p v-if="platform.nodes.length === 0" class="empty-state">当前没有设备，点击右上角“刷新”重新获取列表。</p>
      </div>
    </section>
  </div>
</template>

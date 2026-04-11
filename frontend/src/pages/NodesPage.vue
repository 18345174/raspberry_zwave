<script setup lang="ts">
import { ref } from "vue";

import { usePlatformStore } from "../stores/platform";
import { translatePingResult } from "../utils/ui-text";

const platform = usePlatformStore();
const pingResult = ref<string>("");
const healthResult = ref<string>("");

async function openNode(nodeId: number): Promise<void> {
  await platform.selectNode(nodeId);
}

async function ping(): Promise<void> {
  if (!platform.selectedNode) {
    return;
  }
  pingResult.value = translatePingResult(await platform.pingNode(platform.selectedNode.nodeId));
}

async function heal(): Promise<void> {
  if (!platform.selectedNode) {
    return;
  }
  const result = await platform.healNode(platform.selectedNode.nodeId);
  healthResult.value = JSON.stringify(result, null, 2);
}
</script>

<template>
  <div class="page-grid split-wide">
    <section class="page-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">设备清单</p>
          <h3>节点列表</h3>
        </div>
        <button class="ghost-button" @click="platform.refreshNodes">刷新</button>
      </div>

      <div class="list-column">
        <button v-for="node in platform.nodes" :key="node.nodeId" class="list-card" @click="openNode(node.nodeId)">
          <div>
            <strong>#{{ node.nodeId }} {{ node.product || node.name || '未命名节点' }}</strong>
            <p>{{ node.manufacturer || '未知厂商' }}</p>
          </div>
          <span>{{ node.status || node.interviewStage || '未知状态' }}</span>
        </button>
      </div>
    </section>

    <section class="page-card accent-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">快照</p>
          <h3>节点详情</h3>
        </div>
      </div>

      <template v-if="platform.selectedNode">
        <dl class="details-grid">
          <div>
            <dt>名称</dt>
            <dd>{{ platform.selectedNode.product || platform.selectedNode.name || '-' }}</dd>
          </div>
          <div>
            <dt>安全类</dt>
            <dd>{{ platform.selectedNode.securityClasses.join(', ') || '-' }}</dd>
          </div>
          <div>
            <dt>命令类</dt>
            <dd>{{ platform.selectedNode.commandClasses.join(', ') || '-' }}</dd>
          </div>
          <div>
            <dt>端点</dt>
            <dd>{{ platform.selectedNode.endpoints.map((item) => item.index).join(', ') || '0' }}</dd>
          </div>
        </dl>

        <div class="button-row">
          <button class="primary-button" @click="ping">连通性检查</button>
          <button class="ghost-button" @click="heal">健康检查</button>
          <button class="ghost-button" @click="platform.selectNode(platform.selectedNode.nodeId)">刷新详情</button>
        </div>

        <p v-if="pingResult" class="mono-line">连通性：{{ pingResult }}</p>
        <pre v-if="healthResult" class="code-block">{{ healthResult }}</pre>

        <div class="value-table-wrap">
          <table class="value-table">
            <thead>
              <tr>
                <th>端点</th>
                <th>命令类</th>
                <th>属性</th>
                <th>值</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="value in platform.selectedNode.values.slice(0, 30)" :key="`${value.endpoint}_${value.commandClass}_${value.property}_${value.propertyKey}`">
                <td>{{ value.endpoint }}</td>
                <td>{{ value.commandClass }}</td>
                <td>{{ value.label || value.property }}</td>
                <td>{{ value.value }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <p v-else class="empty-state">从左侧选择一个节点以查看快照。</p>
    </section>
  </div>
</template>

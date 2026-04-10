<script setup lang="ts">
import { ref } from "vue";

import { usePlatformStore } from "../stores/platform";

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
  pingResult.value = (await platform.pingNode(platform.selectedNode.nodeId)) ? "reachable" : "unreachable";
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
          <p class="section-kicker">Inventory</p>
          <h3>节点列表</h3>
        </div>
        <button class="ghost-button" @click="platform.refreshNodes">刷新</button>
      </div>

      <div class="list-column">
        <button v-for="node in platform.nodes" :key="node.nodeId" class="list-card" @click="openNode(node.nodeId)">
          <div>
            <strong>#{{ node.nodeId }} {{ node.product || node.name || 'Unnamed node' }}</strong>
            <p>{{ node.manufacturer || 'Unknown manufacturer' }}</p>
          </div>
          <span>{{ node.status || node.interviewStage || 'unknown' }}</span>
        </button>
      </div>
    </section>

    <section class="page-card accent-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">Snapshot</p>
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
            <dt>Command Classes</dt>
            <dd>{{ platform.selectedNode.commandClasses.join(', ') || '-' }}</dd>
          </div>
          <div>
            <dt>Endpoints</dt>
            <dd>{{ platform.selectedNode.endpoints.map((item) => item.index).join(', ') || '0' }}</dd>
          </div>
        </dl>

        <div class="button-row">
          <button class="primary-button" @click="ping">Ping</button>
          <button class="ghost-button" @click="heal">Health Check</button>
          <button class="ghost-button" @click="platform.selectNode(platform.selectedNode.nodeId)">刷新详情</button>
        </div>

        <p v-if="pingResult" class="mono-line">Ping: {{ pingResult }}</p>
        <pre v-if="healthResult" class="code-block">{{ healthResult }}</pre>

        <div class="value-table-wrap">
          <table class="value-table">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>CC</th>
                <th>Property</th>
                <th>Value</th>
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

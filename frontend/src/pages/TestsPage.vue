<script setup lang="ts">
import { computed, reactive } from "vue";

import { usePlatformStore } from "../stores/platform";
import { translateRunStatus } from "../utils/ui-text";

const platform = usePlatformStore();
const form = reactive({
  nodeId: 0,
  testDefinitionId: "",
  inputsJson: `{
  "repeat": 1
}`,
});

const activeRun = computed(() => platform.latestRun);
const activeLogs = computed(() => {
  if (!activeRun.value) {
    return [];
  }
  return platform.runLogs[activeRun.value.id] ?? [];
});

async function submit(): Promise<void> {
  await platform.runTest({
    nodeId: Number(form.nodeId),
    testDefinitionId: form.testDefinitionId,
    inputs: JSON.parse(form.inputsJson || "{}"),
  });
}

async function loadLogs(runId: string): Promise<void> {
  await platform.loadRunLogs(runId);
}
</script>

<template>
  <div class="page-grid split-wide">
    <section class="page-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">测试引擎</p>
          <h3>创建测试任务</h3>
        </div>
      </div>

      <label class="field-stack">
        <span>节点 ID</span>
        <select v-model="form.nodeId" class="text-input">
          <option value="0">请选择节点</option>
          <option v-for="node in platform.nodes" :key="node.nodeId" :value="node.nodeId">
            #{{ node.nodeId }} {{ node.product || node.name || '未命名节点' }}
          </option>
        </select>
      </label>

      <label class="field-stack">
        <span>测试定义</span>
        <select v-model="form.testDefinitionId" class="text-input">
          <option value="">请选择测试定义</option>
          <option v-for="definition in platform.definitions" :key="definition.id" :value="definition.id">
            {{ definition.name }}
          </option>
        </select>
      </label>

      <label class="field-stack">
        <span>输入参数 JSON</span>
        <textarea v-model="form.inputsJson" class="text-input code-input" rows="10" />
      </label>

      <button class="primary-button" @click="submit">启动测试</button>
    </section>

    <section class="page-card accent-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">实时跟踪</p>
          <h3>任务与日志</h3>
        </div>
      </div>

      <div class="list-column compact">
        <button v-for="run in platform.runs" :key="run.id" class="list-card" @click="loadLogs(run.id)">
          <div>
            <strong>{{ run.testDefinitionId }}</strong>
            <p>{{ run.id }}</p>
          </div>
          <span>{{ translateRunStatus(run.status) }}</span>
        </button>
      </div>

      <div v-if="activeRun" class="run-summary">
        <p class="mono-line">当前任务：{{ activeRun.id }}</p>
        <button class="ghost-button danger" @click="platform.cancelRun(activeRun.id)">取消任务</button>
      </div>

      <pre class="code-block">{{ JSON.stringify(activeLogs, null, 2) }}</pre>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";

import StatusPill from "../components/StatusPill.vue";
import { usePlatformStore } from "../stores/platform";
import { translateBooleanState, translateChallengeType, translateDriverPhase } from "../utils/ui-text";

type FlowMode = "idle" | "include" | "exclude";
type DialogStep =
  | "search"
  | "grant"
  | "dsk"
  | "processing"
  | "include-success"
  | "exclude-success"
  | "stopped";

const platform = usePlatformStore();
const dialogMode = ref<FlowMode>("idle");
const includeUiStage = ref<"search" | "found" | "grant" | "dsk" | "processing">("search");
const includeName = ref("");
const includeNameSaving = ref(false);
const includeNameError = ref("");
const form = reactive({
  pin: "",
  grant: [] as string[],
  clientSideAuth: false,
});

const DEFAULT_INCLUDED_NODE_NAME = "Z-Wave Door Lock";
const securityOptions = ["S2_AccessControl", "S2_Authenticated", "S2_Unauthenticated", "S0_Legacy"];

const flowLabel = computed(() => {
  if (platform.provisioningMode === "include" || platform.status.isInclusionActive) {
    return "添加中";
  }
  if (platform.provisioningMode === "exclude" || platform.status.isExclusionActive) {
    return "删除中";
  }
  return "待机";
});

const flowTone = computed<"good" | "warn">(() => {
  if (platform.provisioningMode !== "idle" || platform.status.isInclusionActive || platform.status.isExclusionActive) {
    return "warn";
  }
  return "good";
});

const driverReady = computed(() => platform.status.phase === "ready");
const challengeType = computed(() => String(platform.inclusionChallenge?.challengeType ?? ""));
const challengeDsk = computed(() =>
  platform.inclusionChallenge?.challengeType === "validate_dsk" ? platform.inclusionChallenge.dsk : "",
);

const canStartInclusion = computed(
  () =>
    driverReady.value &&
    platform.provisioningMode === "idle" &&
    !platform.status.isInclusionActive &&
    !platform.status.isExclusionActive,
);
const canStartExclusion = computed(
  () =>
    driverReady.value &&
    platform.provisioningMode === "idle" &&
    !platform.status.isInclusionActive &&
    !platform.status.isExclusionActive,
);
const canResetController = computed(
  () =>
    driverReady.value &&
    platform.provisioningMode === "idle" &&
    !platform.status.isInclusionActive &&
    !platform.status.isExclusionActive,
);

const dialogOpen = computed(() => dialogMode.value !== "idle");

const dialogStep = computed<DialogStep>(() => {
  if (dialogMode.value === "include") {
    if (platform.latestIncludedNode) {
      return "include-success";
    }
    if (challengeType.value === "grant_security_classes") {
      return "grant";
    }
    if (challengeType.value === "validate_dsk") {
      return "dsk";
    }
    if (platform.status.isInclusionActive) {
      return "search";
    }
    if (includeUiStage.value === "found" || platform.foundIncludedNode) {
      return "processing";
    }
    if (platform.provisioningResult === "running") {
      return "processing";
    }
    if (platform.provisioningResult === "stopped") {
      return "stopped";
    }
    if (includeUiStage.value === "processing" || includeUiStage.value === "grant" || includeUiStage.value === "dsk") {
      return "processing";
    }
    return "search";
  }

  if (dialogMode.value === "exclude") {
    if (platform.latestExcludedNode) {
      return "exclude-success";
    }
    if (platform.status.isExclusionActive) {
      return "search";
    }
    if (platform.provisioningResult === "running") {
      return "processing";
    }
    if (platform.provisioningResult === "stopped") {
      return "stopped";
    }
    return "search";
  }

  return "stopped";
});

const dialogTitle = computed(() => {
  if (dialogMode.value === "include") {
    switch (dialogStep.value) {
      case "grant":
        return "确认安全等级";
      case "dsk":
        return "输入 DSK 前 5 位";
      case "processing":
        return "正在添加设备";
      case "include-success":
        return "添加成功";
      case "stopped":
        return "添加流程已停止";
      default:
        return "正在搜索新设备";
    }
  }

  if (dialogMode.value === "exclude") {
    if (dialogStep.value === "exclude-success") {
      return "设备已删除";
    }
    if (dialogStep.value === "processing") {
      return "正在确认删除结果";
    }
    if (dialogStep.value === "stopped") {
      return "删除流程已停止";
    }
    return "正在等待删除设备";
  }

  return "设备引导";
});

watch(
  () => platform.inclusionChallenge?.requestId,
  () => {
    const challenge = platform.inclusionChallenge;
    form.pin = "";
    form.grant =
      challenge?.challengeType === "grant_security_classes"
        ? [...securityOptions]
        : [];
    form.clientSideAuth =
      challenge?.challengeType === "grant_security_classes"
        ? challenge.clientSideAuth
        : false;
  },
  { immediate: true },
);

watch(
  () => platform.inclusionChallenge?.challengeType,
  (value) => {
    if (value === "grant_security_classes") {
      includeUiStage.value = "grant";
      return;
    }
    if (value === "validate_dsk") {
      includeUiStage.value = "dsk";
      return;
    }
    if (platform.foundIncludedNode) {
      includeUiStage.value = "found";
    }
  },
  { immediate: true },
);

watch(
  () => platform.foundIncludedNode?.timestamp,
  (timestamp) => {
    if (timestamp && !platform.inclusionChallenge) {
      includeUiStage.value = "found";
    }
  },
);

watch(
  () => platform.latestIncludedNode?.nodeId,
  (nodeId) => {
    includeNameSaving.value = false;
    includeNameError.value = "";
    if (!nodeId) {
      includeName.value = "";
      return;
    }
    includeName.value = buildDefaultIncludedNodeName(nodeId);
  },
  { immediate: true },
);

function buildDefaultIncludedNodeName(nodeId: number): string {
  const existingNames = new Set(
    platform.nodes
      .filter((node) => node.nodeId !== nodeId)
      .map((node) => node.name?.trim())
      .filter((name): name is string => Boolean(name)),
  );

  if (!existingNames.has(DEFAULT_INCLUDED_NODE_NAME)) {
    return DEFAULT_INCLUDED_NODE_NAME;
  }

  let suffix = 1;
  while (existingNames.has(`${DEFAULT_INCLUDED_NODE_NAME} ${suffix}`)) {
    suffix += 1;
  }
  return `${DEFAULT_INCLUDED_NODE_NAME} ${suffix}`;
}

async function beginInclusion(): Promise<void> {
  includeUiStage.value = "search";
  await platform.startInclusion();
  if (platform.provisioningMode === "include" || platform.status.isInclusionActive || platform.inclusionChallenge) {
    dialogMode.value = "include";
  }
}

async function beginExclusion(): Promise<void> {
  await platform.startExclusion();
  if (platform.provisioningMode === "exclude" || platform.status.isExclusionActive) {
    dialogMode.value = "exclude";
  }
}

async function resetController(): Promise<void> {
  const confirmed = window.confirm(
    "这会执行与 Z-Wave PC Controller 类似的 Reset Controller / Hard Reset。\n\n控制器中的所有节点（包括在线和已死节点）都会被强制清空，原网络会被彻底删除。设备之后通常还需要先在设备侧恢复出厂，再重新入网。\n\n确定继续吗？",
  );
  if (!confirmed) {
    return;
  }
  closeDialog();
  await platform.resetController();
}

async function submitChallenge(): Promise<void> {
  const challenge = platform.inclusionChallenge;
  if (!challenge) {
    return;
  }

  if (challenge.challengeType === "grant_security_classes") {
    includeUiStage.value = "processing";
    await platform.submitGrantSecurity({
      requestId: String(challenge.requestId),
      grant: form.grant,
      clientSideAuth: form.clientSideAuth,
    });
    return;
  }

  includeUiStage.value = "processing";
  await platform.submitValidateDsk({
    requestId: String(challenge.requestId),
    pin: form.pin,
  });
}

async function stopActiveFlow(): Promise<void> {
  if (dialogMode.value === "include" && platform.status.isInclusionActive) {
    await platform.stopInclusion();
  }
  if (dialogMode.value === "exclude" && platform.status.isExclusionActive) {
    await platform.stopExclusion();
  }
  closeDialog();
}

function closeDialog(): void {
  dialogMode.value = "idle";
  includeUiStage.value = "search";
  includeName.value = "";
  includeNameSaving.value = false;
  includeNameError.value = "";
  form.pin = "";
  form.grant = [];
  form.clientSideAuth = false;
  platform.resetProvisioningFlow();
}

async function saveIncludedNodeName(): Promise<void> {
  const latestNode = platform.latestIncludedNode;
  const normalizedName = includeName.value.trim();

  if (!latestNode) {
    return;
  }
  if (!normalizedName) {
    includeNameError.value = "请输入设备名称。";
    return;
  }

  includeNameSaving.value = true;
  includeNameError.value = "";

  try {
    await platform.renameNode(latestNode.nodeId, normalizedName);
    closeDialog();
  } catch (error) {
    includeNameError.value = error instanceof Error ? error.message : String(error);
  } finally {
    includeNameSaving.value = false;
  }
}
</script>

<template>
  <div class="page-grid page-grid-single">
    <section class="page-card accent-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">设备配网</p>
          <h3>添加 / 删除设备</h3>
        </div>
        <StatusPill :label="flowLabel" :tone="flowTone" />
      </div>

      <dl class="details-grid">
        <div>
          <dt>控制器状态</dt>
          <dd>{{ translateDriverPhase(platform.status.phase) }}</dd>
        </div>
        <div>
          <dt>添加流程</dt>
          <dd>{{ translateBooleanState(platform.status.isInclusionActive) }}</dd>
        </div>
        <div>
          <dt>删除流程</dt>
          <dd>{{ translateBooleanState(platform.status.isExclusionActive) }}</dd>
        </div>
        <div>
          <dt>安全挑战</dt>
          <dd>{{ platform.inclusionChallenge ? translateChallengeType(challengeType) : "无" }}</dd>
        </div>
      </dl>

      <div class="button-row">
        <button class="primary-button" :disabled="!canStartInclusion" @click="beginInclusion">添加设备</button>
        <button class="ghost-button danger" :disabled="!canStartExclusion" @click="beginExclusion">删除设备</button>
        <button class="ghost-button danger" :disabled="!canResetController" @click="resetController">Reset 控制器</button>
      </div>

      <p v-if="!driverReady" class="port-meta">请先在控制器页面连接控制器，等状态变为“已就绪”后再执行添加或删除设备。</p>
      <p v-else class="port-meta">Reset 控制器会强制清空当前控制器内的全部节点，包含在线节点和死节点。</p>
    </section>

    <section v-if="dialogOpen" class="flow-dialog-backdrop">
      <article class="flow-dialog">
        <div class="section-heading">
          <div>
            <p class="section-kicker">{{ dialogMode === "include" ? "添加设备" : "删除设备" }}</p>
            <h3>{{ dialogTitle }}</h3>
          </div>
          <button
            class="ghost-button"
            @click="
              dialogStep === 'include-success' || dialogStep === 'exclude-success' || dialogStep === 'stopped'
                ? closeDialog()
                : stopActiveFlow()
            "
          >
            {{ dialogStep === "include-success" || dialogStep === "exclude-success" || dialogStep === "stopped" ? "关闭" : "取消" }}
          </button>
        </div>

        <template v-if="dialogStep === 'search' && dialogMode === 'include'">
          <div class="flow-state">
            <div class="flow-spinner" />
            <p class="flow-lead">控制器正在搜索新设备，请现在触发设备进入配网模式。</p>
            <p class="flow-copy">建议让设备靠近控制器，并按照设备说明书点击配网键、拨码键或上电触发配网。</p>
          </div>
        </template>

        <template v-else-if="dialogStep === 'search' && dialogMode === 'exclude'">
          <div class="flow-state">
            <div class="flow-spinner" />
            <p class="flow-lead">控制器正在等待删除设备，请现在触发目标设备进入删除模式。</p>
            <p class="flow-copy">通常需要按一次或多次设备上的配网键，具体操作请参考设备说明书。</p>
          </div>
        </template>

        <template v-else-if="dialogStep === 'grant' && platform.inclusionChallenge">
          <div class="flow-state">
            <p class="flow-lead">检测到安全设备，已进入 S2 授权阶段。</p>
            <p class="flow-copy">请确认允许的安全等级，然后继续添加设备。</p>
          </div>

          <p class="mono-line">请求 ID：{{ platform.inclusionChallenge.requestId }}</p>

          <div class="check-list">
            <label v-for="item in securityOptions" :key="item" class="check-item">
              <input v-model="form.grant" :value="item" type="checkbox" />
              <span>{{ item }}</span>
            </label>
            <label class="check-item">
              <input v-model="form.clientSideAuth" type="checkbox" />
              <span>允许客户端侧认证</span>
            </label>
          </div>

          <div class="button-row">
            <button class="primary-button" @click="submitChallenge">继续添加</button>
          </div>
        </template>

        <template v-else-if="dialogStep === 'dsk' && platform.inclusionChallenge">
          <div class="flow-state">
            <p class="flow-lead">该设备请求 S2 安全添加。</p>
            <p class="flow-copy">请根据设备标签或包装盒上的信息，填写 DSK 前 5 位 PIN 码。</p>
          </div>

          <p class="mono-line">DSK：{{ challengeDsk }}</p>

          <label class="field-stack">
            <span>DSK 前 5 位 PIN</span>
            <input v-model="form.pin" class="text-input" maxlength="5" placeholder="例如 12345" />
          </label>

          <div class="button-row">
            <button class="primary-button" :disabled="form.pin.length !== 5" @click="submitChallenge">继续添加</button>
          </div>
        </template>

        <template v-else-if="dialogStep === 'processing'">
          <div class="flow-state">
            <div class="flow-spinner" />
            <template v-if="dialogMode === 'include'">
              <template v-if="platform.foundIncludedNode && !platform.inclusionChallenge">
                <p class="flow-lead">已发现设备，正在请求安全确认。</p>
                <p class="flow-copy">控制器正在识别设备能力并准备下一步安全协商。请保持设备靠近控制器，等待确认安全等级或输入 DSK 的提示出现。</p>
              </template>
              <template v-else-if="platform.pendingIncludedNode">
                <p class="flow-lead">设备已加入网络，正在等待初始化完成。</p>
                <p class="flow-copy">节点 {{ platform.pendingIncludedNode.nodeId }} {{ platform.pendingIncludedNode.name ? `（${platform.pendingIncludedNode.name}）` : "" }} 已加入网络，但系统仍在等待采访完成或安全引导结束。若设备需要 S2 验证，界面会继续弹出确认安全等级或 DSK 输入。</p>
              </template>
              <template v-else>
                <p class="flow-lead">安全信息已提交，正在继续完成设备添加。</p>
                <p class="flow-copy">控制器正在和设备完成 S2 引导、密钥交换和后续握手。这个阶段可能持续几十秒，请不要关闭页面，也不要再次触发设备配网。</p>
              </template>
            </template>
            <template v-else>
              <p class="flow-lead">控制器已结束删除模式，正在确认设备是否已成功移除。</p>
              <p class="flow-copy">系统会继续刷新节点列表一小段时间。如果设备刚完成删除，界面会自动切换到成功状态。</p>
            </template>
          </div>
        </template>

        <template v-else-if="dialogStep === 'include-success' && platform.latestIncludedNode">
          <div class="flow-state">
            <p class="flow-lead">添加成功。</p>
            <p class="flow-copy">节点 {{ platform.latestIncludedNode.nodeId }} {{ platform.latestIncludedNode.name ? `（${platform.latestIncludedNode.name}）` : "" }} 已完成采访。请确认设备名称，保存后会同步到设备列表。</p>
          </div>

          <label class="field-stack">
            <span>设备名称</span>
            <input
              v-model="includeName"
              class="text-input"
              placeholder="请输入设备名称"
              :disabled="includeNameSaving"
              @keydown.enter.prevent="saveIncludedNodeName"
            />
          </label>

          <p v-if="includeNameError" class="inline-error">{{ includeNameError }}</p>

          <div class="button-row">
            <button class="primary-button" :disabled="includeNameSaving || !includeName.trim()" @click="saveIncludedNodeName">
              {{ includeNameSaving ? "保存中..." : "保存并关闭" }}
            </button>
            <button class="ghost-button" :disabled="includeNameSaving" @click="closeDialog">
              稍后再说
            </button>
          </div>
        </template>

        <template v-else-if="dialogStep === 'exclude-success' && platform.latestExcludedNode">
          <div class="flow-state">
            <p class="flow-lead">设备已从网络中移除。</p>
            <p class="flow-copy">节点 {{ platform.latestExcludedNode.nodeId }} 已删除。</p>
          </div>
        </template>

        <template v-else>
          <div class="flow-state">
            <p class="flow-lead">{{ dialogMode === "include" ? "添加流程已停止。" : "删除流程已停止。" }}</p>
            <p class="flow-copy">你可以关闭窗口后重新开始，或先检查设备是否已正确进入配网模式。</p>
          </div>
        </template>
      </article>
    </section>
  </div>
</template>

<style scoped>
.inline-error {
  margin: 0;
  color: var(--bad);
}
</style>

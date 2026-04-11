<script setup lang="ts">
import { computed, reactive } from "vue";

import StatusPill from "../components/StatusPill.vue";
import { usePlatformStore } from "../stores/platform";
import { translateBooleanState, translateChallengeType } from "../utils/ui-text";

const platform = usePlatformStore();
const form = reactive({
  pin: "",
  grant: [] as string[],
  clientSideAuth: false,
});

const securityOptions = ["S2_AccessControl", "S2_Authenticated", "S2_Unauthenticated", "S0_Legacy"];
const flowLabel = computed(() => {
  if (platform.status.isInclusionActive) {
    return "添加中";
  }
  if (platform.status.isExclusionActive) {
    return "删除中";
  }
  return "待机";
});
const flowTone = computed<"good" | "warn">(() => {
  if (platform.status.isInclusionActive || platform.status.isExclusionActive) {
    return "warn";
  }
  return "good";
});

async function submitChallenge(): Promise<void> {
  const challenge = platform.inclusionChallenge;
  if (!challenge) {
    return;
  }

  if (challenge.challengeType === "grant_security_classes") {
    await platform.submitGrantSecurity({
      requestId: String(challenge.requestId),
      grant: form.grant,
      clientSideAuth: form.clientSideAuth,
    });
    return;
  }

  await platform.submitValidateDsk({
    requestId: String(challenge.requestId),
    pin: form.pin,
  });
}
</script>

<template>
  <div class="page-grid page-grid-single">
    <section class="page-card accent-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">安全引导</p>
          <h3>添加 / 删除设备</h3>
        </div>
        <StatusPill :label="flowLabel" :tone="flowTone" />
      </div>

      <div class="button-row">
        <button class="primary-button" @click="platform.startInclusion">开始入网</button>
        <button class="ghost-button" @click="platform.stopInclusion">停止入网</button>
        <button class="ghost-button" @click="platform.startExclusion">开始排除</button>
        <button class="ghost-button danger" @click="platform.stopExclusion">停止排除</button>
      </div>

      <dl class="details-grid">
        <div>
          <dt>入网</dt>
          <dd>{{ translateBooleanState(platform.status.isInclusionActive) }}</dd>
        </div>
        <div>
          <dt>排除</dt>
          <dd>{{ translateBooleanState(platform.status.isExclusionActive) }}</dd>
        </div>
      </dl>

      <div class="section-heading stacked-section-heading">
        <div>
          <p class="section-kicker">挑战桥接</p>
          <h3>安全授权与 DSK 交互</h3>
        </div>
      </div>

      <template v-if="platform.inclusionChallenge">
        <p class="mono-line">请求 ID：{{ platform.inclusionChallenge.requestId }}</p>
        <p class="mono-line">挑战类型：{{ translateChallengeType(String(platform.inclusionChallenge.challengeType)) }}</p>

        <div v-if="platform.inclusionChallenge.challengeType === 'grant_security_classes'" class="check-list">
          <label v-for="item in securityOptions" :key="item" class="check-item">
            <input v-model="form.grant" :value="item" type="checkbox" />
            <span>{{ item }}</span>
          </label>
          <label class="check-item">
            <input v-model="form.clientSideAuth" type="checkbox" />
            <span>允许客户端侧认证</span>
          </label>
        </div>

        <div v-else class="field-stack">
          <p class="mono-line">DSK：{{ platform.inclusionChallenge.dsk }}</p>
          <label>
            <span>PIN 码</span>
            <input v-model="form.pin" class="text-input" maxlength="5" placeholder="12345" />
          </label>
        </div>

        <button class="primary-button" @click="submitChallenge">提交挑战结果</button>
      </template>

      <p v-else class="empty-state">当前没有待处理的安全挑战。</p>
    </section>
  </div>
</template>

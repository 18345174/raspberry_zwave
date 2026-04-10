<script setup lang="ts">
import { reactive } from "vue";

import { usePlatformStore } from "../stores/platform";

const platform = usePlatformStore();
const form = reactive({
  pin: "",
  grant: [] as string[],
  clientSideAuth: false,
});

const securityOptions = ["S2_AccessControl", "S2_Authenticated", "S2_Unauthenticated", "S0_Legacy"];

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
  <div class="page-grid">
    <section class="page-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">Secure Bootstrapping</p>
          <h3>设备添加 / 移除流程</h3>
        </div>
      </div>

      <div class="button-row">
        <button class="primary-button" @click="platform.startInclusion">开始 Inclusion</button>
        <button class="ghost-button" @click="platform.stopInclusion">停止 Inclusion</button>
        <button class="ghost-button" @click="platform.startExclusion">开始 Exclusion</button>
        <button class="ghost-button danger" @click="platform.stopExclusion">停止 Exclusion</button>
      </div>

      <dl class="details-grid">
        <div>
          <dt>Inclusion</dt>
          <dd>{{ platform.status.isInclusionActive ? 'active' : 'idle' }}</dd>
        </div>
        <div>
          <dt>Exclusion</dt>
          <dd>{{ platform.status.isExclusionActive ? 'active' : 'idle' }}</dd>
        </div>
      </dl>
    </section>

    <section class="page-card accent-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">Challenge Bridge</p>
          <h3>安全授权与 DSK 交互</h3>
        </div>
      </div>

      <template v-if="platform.inclusionChallenge">
        <p class="mono-line">Request ID: {{ platform.inclusionChallenge.requestId }}</p>
        <p class="mono-line">Challenge: {{ platform.inclusionChallenge.challengeType }}</p>

        <div v-if="platform.inclusionChallenge.challengeType === 'grant_security_classes'" class="check-list">
          <label v-for="item in securityOptions" :key="item" class="check-item">
            <input v-model="form.grant" :value="item" type="checkbox" />
            <span>{{ item }}</span>
          </label>
          <label class="check-item">
            <input v-model="form.clientSideAuth" type="checkbox" />
            <span>允许 Client Side Authentication</span>
          </label>
        </div>

        <div v-else class="field-stack">
          <p class="mono-line">DSK: {{ platform.inclusionChallenge.dsk }}</p>
          <label>
            <span>PIN</span>
            <input v-model="form.pin" class="text-input" maxlength="5" placeholder="12345" />
          </label>
        </div>

        <button class="primary-button" @click="submitChallenge">提交挑战结果</button>
      </template>

      <p v-else class="empty-state">当前没有待处理的安全挑战。</p>
    </section>
  </div>
</template>

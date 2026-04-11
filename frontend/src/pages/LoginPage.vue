<script setup lang="ts">
import { reactive } from "vue";
import { useRouter } from "vue-router";

import { usePlatformStore } from "../stores/platform";

const platform = usePlatformStore();
const router = useRouter();
const form = reactive({
  username: "admin",
  password: "",
  error: "",
});

async function submit(): Promise<void> {
  form.error = "";
  try {
    await platform.login(form.username, form.password);
    form.password = "";
    await router.push("/controller");
  } catch (error) {
    form.error = error instanceof Error ? error.message : String(error);
  }
}
</script>

<template>
  <section class="auth-panel">
    <div class="auth-copy">
      <p class="section-kicker">Z-Wave Access</p>
      <h2>先登录，再进入控制台。</h2>
      <p class="hero-copy">
        Controller 连接、节点巡检、测试执行和系统配置都收敛到同一套紫色控制台里；入口先做认证，后续操作更干净。
      </p>

      <div class="auth-badges">
        <span class="status-pill" data-tone="good">Controller Runtime</span>
        <span class="status-pill" data-tone="warn">Live Diagnostics</span>
        <span class="status-pill" data-tone="neutral">Raspberry Pi</span>
      </div>
    </div>

    <section class="auth-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">Authentication</p>
          <h3>登录测试平台</h3>
        </div>
      </div>

      <p v-if="!platform.authSession.supportsPasswordLogin" class="empty-state">
        当前后端未启用密码登录；如果配置了 `API_TOKEN`，请在 `System` 页面直接保存 token。
      </p>

      <label class="field-stack">
        <span>Username</span>
        <input v-model="form.username" class="text-input" autocomplete="username" />
      </label>

      <label class="field-stack">
        <span>Password</span>
        <input v-model="form.password" class="text-input" type="password" autocomplete="current-password" />
      </label>

      <div class="button-row">
        <button class="primary-button" :disabled="!platform.authSession.supportsPasswordLogin" @click="submit">登录</button>
        <button class="ghost-button" @click="platform.logout">清除会话</button>
      </div>

      <p v-if="form.error" class="error-text">{{ form.error }}</p>

      <div class="auth-meta">
        <p class="mono-line">Authenticated: {{ platform.authSession.isAuthenticated ? 'yes' : 'no' }}</p>
        <p class="mono-line">User: {{ platform.authSession.username || '-' }}</p>
        <p class="mono-line">Expires: {{ platform.authSession.expiresAt || '-' }}</p>
      </div>
    </section>
  </section>
</template>

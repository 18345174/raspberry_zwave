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
  <div class="page-grid">
    <section class="page-card accent-card">
      <div class="section-heading">
        <div>
          <p class="section-kicker">Authentication</p>
          <h3>登录测试平台</h3>
        </div>
      </div>

      <p class="hero-copy">
        当后端启用了 `ADMIN_PASSWORD` 或 `ADMIN_PASSWORD_HASH` 后，浏览器需要先登录，再访问 HTTP API 与 WebSocket。
      </p>

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
        <button class="ghost-button" @click="platform.logout">退出当前会话</button>
      </div>

      <p v-if="form.error" class="error-text">{{ form.error }}</p>
      <p class="mono-line">Authenticated: {{ platform.authSession.isAuthenticated ? 'yes' : 'no' }}</p>
      <p class="mono-line">User: {{ platform.authSession.username || '-' }}</p>
      <p class="mono-line">Expires: {{ platform.authSession.expiresAt || '-' }}</p>
    </section>
  </div>
</template>

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
    window.alert(`登录失败\n\n${form.error}`);
  }
}
</script>

<template>
  <section class="auth-panel">
    <section class="auth-card">
      <h1 class="auth-title">树莓派 Z-Wave 测试平台</h1>

      <label class="field-stack">
        <span>用户名</span>
        <input v-model="form.username" class="text-input" autocomplete="username" />
      </label>

      <label class="field-stack">
        <span>密码</span>
        <input v-model="form.password" class="text-input" type="password" autocomplete="current-password" />
      </label>

      <div class="button-row">
        <button class="primary-button" :disabled="!platform.authSession.supportsPasswordLogin" @click="submit">登录</button>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  eyebrow: string;
  title: string;
  value: string;
  note?: string;
  compact?: boolean;
}>();
</script>

<template>
  <article class="metric-card" :data-compact="compact ? 'true' : 'false'">
    <p class="metric-eyebrow">{{ eyebrow }}</p>
    <h3>{{ title }}</h3>
    <p class="metric-value">{{ value }}</p>
    <p v-if="note" class="metric-note">{{ note }}</p>
  </article>
</template>

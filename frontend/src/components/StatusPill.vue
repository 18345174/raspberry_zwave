<script setup lang="ts">
defineProps<{
  label: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}>();
</script>

<template>
  <span class="status-pill" :data-tone="tone ?? 'neutral'">{{ label }}</span>
</template>

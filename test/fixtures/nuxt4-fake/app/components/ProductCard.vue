<template>
  <div>{{ product?.id }}</div>
</template>

<script setup lang="ts">
const props = defineProps<{ id: string }>();
const product = await $fetch(`/api/products/${props.id}`);
</script>

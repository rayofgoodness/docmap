<template>
  <div>{{ cart }}</div>
</template>

<script setup lang="ts">
// Fetches the peer Magento project's REST cart endpoint directly by its literal path.
const cart = await $fetch('/rest/V1/carts/mine');
</script>

<script setup lang="ts">
const cart = useCartStore();
</script>

<template>
  <p>{{ cart.total }}</p>
</template>

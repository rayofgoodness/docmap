<script setup lang="ts">
import { useCartStore } from '~/stores/cart';

const cart = useCartStore();
</script>

<template>
  <span>{{ cart.items.length }}</span>
</template>

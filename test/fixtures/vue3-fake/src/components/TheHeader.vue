<script setup lang="ts">
import { useCartStore } from '../stores/cart';
import { useFormatPrice } from '../composables/useFormatPrice';

const cart = useCartStore();
const { format } = useFormatPrice();
</script>

<template>
  <header>{{ format(cart.total) }}</header>
</template>

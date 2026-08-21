<template>
  <CartSummary :total="total" />
</template>

<script setup lang="ts">
import CartSummary from '~/components/CartSummary.vue';
import { useFormatPrice } from '~/composables/useFormatPrice';

const { data } = await useFetch('/api/cart');
const cart = useCartStore();
const total = useFormatPrice(data.value?.items.length ?? 0);
</script>

<template>
  <div>Checkout</div>
</template>

<script setup lang="ts">
import { useCheckoutStore } from '../stores/checkout';

const checkout = useCheckoutStore();
const { data } = await useFetch('/api/shipping');
</script>

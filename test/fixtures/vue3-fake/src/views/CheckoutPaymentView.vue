<script setup lang="ts">
const checkoutPayment = useCheckoutPaymentStore();
</script>

<template>
  <p>{{ checkoutPayment.method }}</p>
</template>

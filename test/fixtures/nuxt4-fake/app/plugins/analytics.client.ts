export default defineNuxtPlugin(() => {
  const checkoutPayment = useCheckoutPaymentStore();
  console.log('analytics plugin initialized', checkoutPayment.method);
});

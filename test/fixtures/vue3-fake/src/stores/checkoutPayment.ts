import { defineStore } from 'pinia';

export const useCheckoutPaymentStore = defineStore('checkout-payment', {
  state: () => ({ method: 'card' as string }),
});

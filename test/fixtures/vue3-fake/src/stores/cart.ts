import { defineStore } from 'pinia';

export const useCartStore = defineStore('cart', {
  state: () => ({ total: 0 }),
});

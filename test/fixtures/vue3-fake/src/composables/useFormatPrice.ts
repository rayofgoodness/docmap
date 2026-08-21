export function useFormatPrice() {
  return { format: (n: number) => `$${n.toFixed(2)}` };
}

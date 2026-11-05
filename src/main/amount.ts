/** Decimal <-> integer conversion. Floats never touch money. */
export function parseAmount(input: string, decimals: number): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('금액 형식이 올바르지 않아.');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`소수점 ${decimals}자리까지만 입력할 수 있어.`);
  const value = BigInt(whole + frac.padEnd(decimals, '0'));
  if (value <= 0n) throw new Error('0보다 큰 금액을 입력해.');
  return value;
}

export function formatAmount(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const digits = (neg ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

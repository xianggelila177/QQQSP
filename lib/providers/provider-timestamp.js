// Preserve nanosecond ordering; Date.parse alone truncates to milliseconds.
export function tradeTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const seconds = Date.parse(match[1] + 'Z');
  if (!Number.isFinite(seconds) || seconds <= 0 || new Date(seconds).toISOString().slice(0,19) !== match[1]) return null;
  const fractional = (match[2] || '').padEnd(9, '0');
  return {milliseconds: seconds + Math.floor(Number(fractional) / 1e6), order: BigInt(seconds) * 1000000n + BigInt(fractional)};
}


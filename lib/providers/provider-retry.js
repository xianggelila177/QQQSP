// Provider hints are lower bounds, not permission to retry immediately.
export function providerRetryAt(headers, now, fallbackMs = 60000) {
  const read = name => headers?.get?.(name) ?? headers?.[name] ??
    Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
  const raw = read('retry-after');
  let hinted = 0;
  if (raw != null && /^\d+(?:\.\d+)?$/.test(String(raw).trim())) hinted = now + Number(raw) * 1000;
  else if (raw != null) hinted = Date.parse(raw) || 0;
  const reset = Number(read('x-ratelimit-reset'));
  const resetAt = Number.isFinite(reset) && reset > 0 ? (reset < 1e12 ? reset * 1000 : reset) : 0;
  return Math.max(now + fallbackMs, Number.isFinite(hinted) ? hinted : 0, resetAt);
}

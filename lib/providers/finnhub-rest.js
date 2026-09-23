import { providerRetryAt } from './provider-retry.js';

const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const MAX_TOKENS = 8;

export function parseFinnhubTokens(primary = '', pooled = '') {
  const values = [primary, ...(Array.isArray(pooled) ? pooled : String(pooled || '').split(','))]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  if (values.some(value => !TOKEN.test(value))) throw new TypeError('Finnhub token pool contains an invalid entry');
  const unique = [...new Set(values)];
  if (unique.length > MAX_TOKENS) throw new TypeError(`Finnhub token pool supports at most ${MAX_TOKENS} entries`);
  return Object.freeze(unique);
}

const unavailable = (code, retryAt, cause) => Object.assign(new Error('Finnhub REST source unavailable'), {
  code,
  ...(Number.isFinite(retryAt) && retryAt > 0 ? { retryAt } : {}),
  ...(cause ? { cause } : {}),
});

export function createFinnhubRestPool({ httpsGet, tokens = [], now = Date.now, timeout = 8000 } = {}) {
  if (typeof httpsGet !== 'function') throw new TypeError('Finnhub REST pool requires httpsGet');
  if (!Number.isInteger(timeout) || timeout < 250 || timeout > 30000) throw new TypeError('Invalid Finnhub REST timeout');
  const values = parseFinnhubTokens('', tokens);
  const slots = values.map((token, index) => ({ token, index, retryAt: 0, lastStatus: null }));
  const counts = { requests: 0, successes: 0, failovers: 0, rateLimits: 0, rejected: 0, failures: 0 };
  let cursor = 0;

  function choose(at, tried) {
    for (let offset = 0; offset < slots.length; offset++) {
      const slot = slots[(cursor + offset) % slots.length];
      if (!tried.has(slot.index) && slot.retryAt <= at) {
        cursor = (slot.index + 1) % slots.length;
        return slot;
      }
    }
    return null;
  }

  function cooldown(slot, response, at) {
    slot.lastStatus = response.status;
    if (response.status === 429) {
      counts.rateLimits++;
      slot.retryAt = providerRetryAt(response.headers, at, 60000);
      return 'FINNHUB_RATE_LIMITED';
    }
    if (response.status === 401 || response.status === 403) {
      counts.rejected++;
      slot.retryAt = at + 15 * 60 * 1000;
      return 'FINNHUB_CREDENTIAL_REJECTED';
    }
    if (response.status >= 500) {
      counts.failures++;
      slot.retryAt = at + 30000;
      return 'FINNHUB_SOURCE_UNAVAILABLE';
    }
    return null;
  }

  async function request(path, { signal, timeout: requestTimeout = timeout } = {}) {
    signal?.throwIfAborted();
    if (!slots.length) throw unavailable('FINNHUB_DISABLED');
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new TypeError('Invalid Finnhub REST path');
    const tried = new Set();
    let lastError = null;
    while (tried.size < slots.length) {
      const at = now(), slot = choose(at, tried);
      if (!slot) break;
      tried.add(slot.index); counts.requests++;
      let response;
      try {
        response = await httpsGet('https://finnhub.io/api/v1' + path, {
          Accept: 'application/json',
          'X-Finnhub-Token': slot.token,
        }, { signal, timeout: requestTimeout, gatePartition: 'rest-' + slot.index });
      } catch (error) {
        if (signal?.aborted) throw error;
        counts.failures++; slot.lastStatus = null; slot.retryAt = at + 30000;
        lastError = unavailable('FINNHUB_SOURCE_UNAVAILABLE', slot.retryAt, error);
        if (tried.size < slots.length) counts.failovers++;
        continue;
      }
      const code = cooldown(slot, response, now());
      if (!code) {
        if (response.status === 200) {
          slot.retryAt = 0; slot.lastStatus = 200; counts.successes++;
        }
        return response;
      }
      lastError = unavailable(code, slot.retryAt);
      if (tried.size < slots.length) counts.failovers++;
    }
    const retryAt = Math.min(...slots.map(slot => slot.retryAt).filter(value => value > now()));
    throw lastError || unavailable('FINNHUB_POOL_COOLDOWN', Number.isFinite(retryAt) ? retryAt : undefined);
  }

  function diagnostics() {
    const at = now(), next = Math.min(...slots.map(slot => slot.retryAt).filter(value => value > at));
    return {
      enabled: slots.length > 0,
      tokenCount: slots.length,
      availableTokens: slots.filter(slot => slot.retryAt <= at).length,
      coolingTokens: slots.filter(slot => slot.retryAt > at).length,
      nextAvailableAt: Number.isFinite(next) ? next : null,
      counts: { ...counts },
    };
  }

  return Object.freeze({ request, diagnostics });
}

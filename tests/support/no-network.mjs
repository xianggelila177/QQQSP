// Loaded only by the deterministic runner. Tests may use loopback fixture servers,
// but an overlooked provider stub must never become a real external request.
import net from 'node:net';
const originalConnect = net.Socket.prototype.connect;
let denied = 0;
function localHost(host) { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host || 'localhost').toLowerCase()); }
function blocked() { denied++; return Object.assign(new Error('External network blocked by deterministic test sandbox'), { code: 'ERR_TEST_EXTERNAL_NETWORK_BLOCKED' }); }
net.Socket.prototype.connect = function (...input) {
  const args = Array.isArray(input[0]) ? input[0] : input;
  const options = typeof args[0] === 'object' ? args[0] : { host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  if (options?.path || !localHost(options?.host || options?.hostname)) {
    const error = blocked(); queueMicrotask(() => this.destroy(error)); return this;
  }
  return originalConnect.apply(this, input);
};
const originalFetch = globalThis.fetch;
if (originalFetch) globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!localHost(url.hostname)) return Promise.reject(blocked());
  return originalFetch(input, options);
};
process.on('exit', () => { if (denied) { console.error(`Deterministic sandbox blocked ${denied} unexpected external network attempt(s).`); process.exitCode = 1; } });

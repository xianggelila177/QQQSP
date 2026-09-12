import net from 'node:net';
import {createTaskQueue} from './task-queue.js';

export function boundedInt(value, fallback, min, max) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function safeError(value, fallback = 'UNAVAILABLE') {
  return String(value || fallback).replace(/[\r\n\t]+/g, ' ').slice(0, 256) || fallback;
}

export function clientIdentity(req, trustProxy = false) {
  const remote = String(req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  if (trustProxy && (remote === '127.0.0.1' || remote === '::1')) {
    const forwarded = String(req.headers['cf-connecting-ip'] || '').trim();
    if (net.isIP(forwarded)) return forwarded;
  }
  return remote;
}

export function withDeadline(promise, ms) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('request deadline exceeded'), {code:'DEADLINE_EXCEEDED'}));
      promise.cancel?.();
    }, ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

// A shared deadline bounds the whole response while retaining completed siblings.
export function settleWithin(tasks, ms) {
  if (!tasks.length) return Promise.resolve([]);
  return new Promise(resolve => {
    const results = new Array(tasks.length);
    const done = new Set();
    let finished = false;
    const finish = () => { if (finished) return; finished = true; clearTimeout(timer); resolve(results); };
    const timer = setTimeout(() => {
      for (let i = 0; i < tasks.length; i++) if (!done.has(i)) {
        results[i] = {__error:Object.assign(new Error('request deadline exceeded'), {code:'DEADLINE_EXCEEDED'})};
        tasks[i].cancel?.();
      }
      finish();
    }, ms);
    tasks.forEach((task, index) => Promise.resolve(task).then(
      value => { if (!finished) { results[index] = value; done.add(index); } },
      error => { if (!finished) { results[index] = {__error:error}; done.add(index); } }
    ).finally(() => { if (done.size === tasks.length) finish(); }));
  });
}

export function createAdmission({env = {}, now = Date.now} = {}) {
  const maxActive = boundedInt(env.HTTP_ACTIVE_MAX, 32, 1, 256);
  const maxQueue = boundedInt(env.HTTP_QUEUE_MAX, 64, 0, 512);
  const expensiveLimit = boundedInt(env.HTTP_CLIENT_QUOTA, 120, 1, 10000);
  const snapshotLimit = boundedInt(env.HTTP_SNAPSHOT_QUOTA, env.HTTP_CLIENT_QUOTA ? expensiveLimit : 600, 1, 10000);
  const clients = new Map();
  const queue=createTaskQueue({maxActive,maxQueued:maxQueue,now});
  const run=queue.run;
  const consume = (req, kind = 'expensive') => {
    const key = clientIdentity(req, env.TRUST_PROXY_LOOPBACK === '1');
    const at = now();
    let entry = clients.get(key);
    if (!entry || at - entry.startedAt >= 60000) entry = {startedAt:at,snapshot:0,expensive:0};
    const bucket = kind === 'snapshot' ? 'snapshot' : 'expensive';
    entry[bucket]++; clients.set(key,entry);
    if (clients.size > 4096) {
      for (const [id, value] of clients) if (at - value.startedAt >= 60000) clients.delete(id);
      while (clients.size > 4096) clients.delete(clients.keys().next().value);
    }
    return {ok:entry[bucket] <= (bucket === 'snapshot' ? snapshotLimit : expensiveLimit),retryAfter:Math.max(1,Math.ceil((60000-(at-entry.startedAt))/1000))};
  };
  const diagnostics = () => ({...queue.diagnostics(),clients:clients.size,snapshotLimit,expensiveLimit});
  return Object.freeze({run,consume,diagnostics,close(){clients.clear();queue.close();},reopen:queue.reopen});
}

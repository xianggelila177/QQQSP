import { validateXmlDocument } from '../xml-structure.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS_PER_SOURCE = 8;
const MAX_ITEMS = 18;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const EMPTY_NODE = Object.freeze({ text: [], children: [] });
export const OFFICIAL_FEEDS = Object.freeze([
  Object.freeze({ id: 'fed', name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml', hosts: ['federalreserve.gov', 'www.federalreserve.gov'] }),
  Object.freeze({ id: 'ecb', name: 'ECB', url: 'https://www.ecb.europa.eu/rss/press.html', hosts: ['ecb.europa.eu', 'www.ecb.europa.eu'] }),
  Object.freeze({ id: 'bea', name: 'BEA', url: 'https://apps.bea.gov/rss/rss.xml', hosts: ['bea.gov', 'www.bea.gov', 'apps.bea.gov'] }),
]);

export const MACRO_OFFICIAL_FEEDS = Object.freeze([
 ...OFFICIAL_FEEDS,
 Object.freeze({id:'bls-cpi',ttlMs:300000,name:'BLS 消费者价格指数',url:'https://www.bls.gov/feed/cpi.rss',hosts:['www.bls.gov','bls.gov']}),
 Object.freeze({id:'eia-energy',ttlMs:900000,name:'EIA 能源分析',url:'https://www.eia.gov/rss/todayinenergy.xml',hosts:['www.eia.gov','eia.gov']}),
]);
function asMillis(value) { const n = value instanceof Date ? value.getTime() : Number(value); return Number.isFinite(n) ? n : Date.now(); }
function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || headers.get(name.toLowerCase()) || '');
  return String(headers[name] ?? headers[name.toLowerCase()] ?? '');
}
function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, entity) => {
    const lower = entity.toLowerCase(); if (lower === 'amp') return '&'; if (lower === 'lt') return '<'; if (lower === 'gt') return '>'; if (lower === 'quot') return '"'; if (lower === 'apos') return "'";
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return all;
    try { return String.fromCodePoint(code); } catch { return all; }
  });
}
function nodeText(node, limit) {
  let raw = ''; const append = value => { raw += value; if (raw.length > limit) throw new Error('RSS field exceeds length limit'); };
  const visit = current => { for (const value of current.text || []) append(value); for (const child of current.children || []) visit(child); };
  visit(node); return decodeEntities(raw).replace(/[\t\r\n ]+/g, ' ').trim();
}
function childNode(node, name) { return (node.children || []).find(child => child.name.toLowerCase() === name) || EMPTY_NODE; }
function parseUrl(value, hosts) { try { const u = new URL(value); return u.protocol === 'https:' && hosts.includes(u.hostname) ? u.href : null; } catch { return null; } }

function parseRss(body, feed, nowMs) {
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('XML body exceeds 2 MiB limit');
  if (/^\s*<!doctype\s+html\b/i.test(body) || /^\s*<html\b/i.test(body)) throw new Error('HTML/challenge body rejected');
  const tree = validateXmlDocument(body, { tree: true });
  if (tree.name!=='rss'||tree.attrs.version !== '2.0') throw new Error('RSS 2.0 root and version required');
  const channels = tree.children.filter(node => node.name.toLowerCase() === 'channel'); if (channels.length !== 1) throw new Error('RSS channel required');
  const out = []; const seen = new Set(); const itemNodes = channels[0].children.filter(node => node.name.toLowerCase() === 'item');
  const hasNestedItem = node => (node.children || []).some(child => child.name.toLowerCase() === 'item' || hasNestedItem(child));
  for (const item of itemNodes) {
    if (hasNestedItem(item)) throw new Error('Nested RSS item rejected');
    let title; let pubDate; let link;
    try { title = nodeText(childNode(item, 'title'), 2048); pubDate = nodeText(childNode(item, 'pubdate'), 128); link = parseUrl(nodeText(childNode(item, 'link'), 4096), feed.hosts); }
    catch (error) { if (/field exceeds/.test(String(error?.message))) continue; throw error; }
    if (!title || !pubDate || !link) continue;
    const published = Date.parse(pubDate); if (!Number.isFinite(published) || published > nowMs || published < nowMs - MAX_AGE_MS || seen.has(link)) continue;
    let sourceText='';try{sourceText=nodeText(childNode(item,'description'),20000).replace(/<[^>]*>/g,' ').slice(0,1800);}catch{}
    seen.add(link); out.push({ title, source: feed.name, pubDate, link, sourceText, topic: '官方公告', official: true }); if (out.length >= MAX_ITEMS_PER_SOURCE) break;
  }
  return out;
}

function reportFor(feed, state, nowMs) {
  const age = state.successAt == null ? Infinity : nowMs - state.successAt;
  const items = state.items.filter(item => { const published = Date.parse(item.pubDate); return Number.isFinite(published) && published <= nowMs && published >= nowMs - MAX_AGE_MS; });
  return { id: feed.id, name: feed.name, source: feed.name, url: feed.url, ok: !state.error, itemCount: items.length, successAt: state.successAt, lastSuccessAt: state.successAt, lastAttemptAt: state.lastAttemptAt, error: state.error || null, stale: !(state.successAt != null && age >= 0 && age < state.ttlMs), inflight: !!state.inflight };
}

export function createOfficialFeeds({ httpsGet, now = () => Date.now(), log = () => {}, ttlMs = 1800000, failureCooldownMs = 300000, feeds=OFFICIAL_FEEDS } = {}) {
  const ttl = Math.max(0, Number(ttlMs) || 0); const cooldown = Math.max(0, Number(failureCooldownMs) || 0);
  const state = new Map(feeds.map(feed => [feed.id, { items: [], successAt: null, lastAttemptAt: null, lastFailureAt: null, error: null, inflight: null, ttlMs: feed.ttlMs??ttl }]));
  function writeLog(level, message, details) { try { if (typeof log === 'function') log(message, details); else if (log && typeof log[level] === 'function') log[level](message, details); } catch {} }
  async function fetchOne(feed, entry) {
    entry.lastAttemptAt = asMillis(now());
    try {
      const response = await httpsGet(feed.url, { Accept: 'application/rss+xml, application/xml, text/xml' }); const status = Number(response?.status);
      if (!Number.isInteger(status) || status < 200 || status >= 300) throw new Error(`${feed.name} HTTP ${status || 'unknown'}`);
      const body = typeof response.body === 'string' ? response.body : Buffer.isBuffer(response.body) ? response.body.toString('utf8') : ''; const type = headerValue(response.headers, 'content-type').toLowerCase();
      if (type.includes('text/html') || type.includes('application/xhtml')) throw new Error(`${feed.name} HTML/challenge body rejected`);
      entry.items = parseRss(body, feed, asMillis(now())); entry.successAt = asMillis(now()); entry.lastFailureAt = null; entry.error = null; return entry.items;
    } catch (error) { entry.lastFailureAt = asMillis(now()); entry.error = String(error?.message || error || 'feed failure'); writeLog('warn', '[official feed failure]', { source: feed.id, error: entry.error }); return entry.items; }
    finally { entry.inflight = null; }
  }
  function loadOne(feed) {
    const entry = state.get(feed.id); const t = asMillis(now()); const age = entry.successAt == null ? Infinity : t - entry.successAt;
    if (entry.successAt != null && age >= 0 && age < entry.ttlMs) return Promise.resolve(entry.items);
    if (entry.lastFailureAt != null && t - entry.lastFailureAt >= 0 && t - entry.lastFailureAt < cooldown) return Promise.resolve(entry.items);
    if (entry.inflight) return entry.inflight; entry.inflight = fetchOne(feed, entry); return entry.inflight;
  }
  function snapshot() {
    const t = asMillis(now()); const sources = feeds.map(feed => reportFor(feed, state.get(feed.id), t)); const updatedAt = sources.reduce((max, item) => item.successAt != null ? Math.max(max, item.successAt) : max, 0) || null;
    const items = feeds.flatMap(feed => state.get(feed.id).items).filter(item => { const published = Date.parse(item.pubDate); return Number.isFinite(published) && published <= t && published >= t - MAX_AGE_MS; }).sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate)).slice(0, MAX_ITEMS);
    const errors = sources.filter(item => item.error).map(item => `${item.id}: ${item.error}`); const result = { items, sources, updatedAt, stale: sources.some(item => item.stale || item.error) }; if (errors.length) result.error = errors.join('; '); return result;
  }
  async function getNews() { await Promise.all(feeds.map(loadOne)); return snapshot(); }
  return { getNews, diagnostics: snapshot };
}

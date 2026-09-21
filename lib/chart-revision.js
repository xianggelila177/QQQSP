import crypto from 'node:crypto';

const revisions = new WeakMap();
export function chartRevision(bars) {
  if(!Array.isArray(bars) || !bars.length) return 0;
  if(revisions.has(bars)) return revisions.get(bars);
  const canonical=bars.map(b=>[b?.t??null,b?.o??null,b?.h??null,b?.l??null,b?.c??null,b?.v??null]);
  const value=Number.parseInt(crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0,12),16);
  if(Object.isFrozen(bars) && bars.every(b=>b && typeof b==='object' && Object.isFrozen(b))) revisions.set(bars,value);
  return value;
}

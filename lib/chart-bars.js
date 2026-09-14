import {volumeNumber} from './quote-contract.js';
  // 提取 OHLC 柱(K线用): {t,o,h,l,c}
export function barsFrom(res) {
    const t = res.timestamp || [];
    const q = res.indicators?.quote?.[0] || {};
    const out = [];
    for (let i = 0; i < t.length; i++) {
      if (q.close?.[i] == null) continue;
      let hh = q.high?.[i], ll = q.low?.[i];
      const oo = q.open?.[i] ?? q.close[i], cc = q.close[i];
      // 脏柱防御(Yahoo盘前后偶发): 高低缺失/与开收矛盾/单柱振幅>6% 时, 用开收替代高低
      const base = Math.abs(cc) || 1;
      if (hh == null || ll == null || hh < Math.max(oo, cc) || ll > Math.min(oo, cc)) {
        hh = Math.max(oo, cc); ll = Math.min(oo, cc);
      }
      out.push({ t: t[i], o: oo, h: hh, l: ll, c: cc, v: volumeNumber(q.volume?.[i]) });
    }
    return out;
  }


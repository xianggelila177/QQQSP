// tests/_test_fx_batch.mjs — P1-P4 getFxRates 上游请求数回归测试
// 问题: 4个币种各打一次 Yahoo chart 接口 = 每次刷新4次HTTPS
// 期望: 用 v7/finance/quote 多符号单次查询(≤1次HTTP); v7缺项时才回退逐符号chart补齐; 全失败保旧值语义不变
process.env.PORT = '0';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, '|', detail); } };

const V7_FULL = JSON.stringify({ quoteResponse: { result: [
  { symbol: 'CNY=X', regularMarketPrice: 7.12 }, { symbol: 'USDKRW=X', regularMarketPrice: 1380.5 },
  { symbol: 'USDJPY=X', regularMarketPrice: 151.2 }, { symbol: 'USDHKD=X', regularMarketPrice: 7.81 },
  ...Object.entries({GBP:.8,EUR:.9,CHF:.85,CAD:1.4,AUD:1.5,INR:84,SGD:1.3,TWD:32,BRL:5.5,MXN:20,ZAR:18}).map(([currency,regularMarketPrice])=>({symbol:'USD'+currency+'=X',regularMarketPrice}))] } });

async function main() {
  const S = await import('../server.js');
  let n = 0; const urls = [];

  console.log('[T1] 正常路径: 全球币种合并为 ≤1 次 httpsGet');
  {
    S.__test.resetState(); S.__test.seedCrumb();               // 预置crumb: 计数只针对行情抓取本身
    S.__upstream.impl = (url) => { n++; urls.push(String(url));
      if (String(url).includes('/v7/finance/quote')) return { status: 200, headers: {}, body: V7_FULL };
      throw new Error('unexpected upstream: ' + url); };
    const rates = await S.__deps.getFxRates();
    check('httpsGet ≤ 1 次(而非4)', n <= 1, 'n=' + n + ' urls=' + JSON.stringify(urls));
    check('四币种汇率正确', rates.USD === 7.12 && rates.KRW === 1380.5 && rates.JPY === 151.2 && rates.HKD === 7.81, JSON.stringify(rates));
  }

  console.log('[R1] 回归: v7缺项时回退chart补齐, 且v7已有值不被覆盖');
  {
    S.__test.resetState(); S.__test.seedCrumb();
    S.__upstream.impl = (url) => {
      const u = String(url);
      if (u.includes('/v7/finance/quote')) return { status: 200, headers: {}, body: JSON.stringify({ quoteResponse: { result: [
        { symbol: 'CNY=X', regularMarketPrice: 7.12 }, { symbol: 'USDKRW=X', regularMarketPrice: 1380.5 },
        { symbol: 'USDJPY=X', regularMarketPrice: 151.2 }] } }) };   // 缺 HKD
      if (u.includes('/v8/finance/chart/')) return { status: 200, headers: {}, body: JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 9.99 } }] } }) };   // 干扰值
      throw new Error('unexpected upstream: ' + u); };
    const rates = await S.__deps.getFxRates();
    check('v7已有值不被覆盖', rates.USD === 7.12 && rates.KRW === 1380.5 && rates.JPY === 151.2, JSON.stringify(rates));
    check('缺失币种由chart兜底补齐(HKD=9.99)', rates.HKD === 9.99, JSON.stringify(rates));
  }

  console.log('[R2] 回归: 60s内缓存命中零请求; 过期后全失败保旧值');
  {
    S.__test.resetState(); S.__test.seedCrumb();
    S.__upstream.impl = () => ({ status: 200, headers: {}, body: V7_FULL });
    await S.__deps.getFxRates();                               // 建立缓存
    n = 0;
    await S.__deps.getFxRates();                               // 应纯缓存读
    check('60s内缓存命中0请求', n === 0, 'n=' + n);
    const origNow = Date.now;
    Date.now = () => origNow() + 61000;                        // 模拟61s: 缓存过期
    S.__upstream.impl = () => { n++; throw new Error('net down'); };
    const r3 = await S.__deps.getFxRates();
    Date.now = origNow;
    check('过期+全失败 → 保旧值', r3.USD === 7.12 && r3.KRW === 1380.5 && r3.JPY === 151.2 && r3.HKD === 7.81, JSON.stringify(r3));
  }
}

main().then(() => { console.log('\n结果: ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });

import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHttp} from '../../lib/http.js';
import {currencyUnitInfo} from '../../lib/currency.js';

test('static asset versions reject stale and ambiguous URLs rather than caching current bytes under them',async t=>{
  const version=fs.readFileSync(new URL('../../VERSION',import.meta.url),'utf8').trim();
  const layer=createHttp({cacheSizes:()=>({})},{env:{PORT:0},monitorCore:false});
  layer.startListen();await once(layer.httpServer,'listening');t.after(()=>layer.stop());
  const base='http://127.0.0.1:'+layer.httpServer.address().port;
  for(const asset of ['panel.bundle.js','style.css','icon.svg']){
    const good=await fetch(`${base}/${asset}?v=${version}`);
    assert.equal(good.status,200);assert.match(good.headers.get('cache-control'),/immutable/);await good.arrayBuffer();
    for(const v of ['111','',`${version}&v=111`]){
      if(v===version)continue;
      const bad=await fetch(`${base}/${asset}?v=${v}`,{headers:{'Accept-Encoding':'br,gzip'}});
      assert.equal(bad.status,409,`${asset}?v=${v}`);assert.match(bad.headers.get('cache-control'),/no-store/);
      assert.equal((await bad.json()).code,'ASSET_VERSION_MISMATCH');
    }
  }
});

test('frontend and backend agree on source currency-unit normalization, including pence and unknown units',()=>{
  const window={};vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/panel-currency.js',import.meta.url),'utf8'),{window});
  for(const input of ['USD',' usd ','GBP','GBp','GBX','gbx',' GBX ','ZAc','zac',' ZAc ','XYZ','']){
    const front=window.PANEL_CURRENCY.currencyUnit(input),back=currencyUnitInfo(input);
    assert.deepEqual({unit:front.unit,currency:front.base,scale:front.scale},back,input);
  }
});

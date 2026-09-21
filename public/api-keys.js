'use strict';
(()=>{
 const $=id=>document.getElementById(id);let token='',busy=false,epoch=0;
 const say=message=>{$('status').textContent=message;};
 const labels={'quote-only':'行情／基础资料',history:'历史／日历',macro:'资讯／宏观',active:'有效',rotating:'轮换宽限期',revoked:'已撤销',expired:'已到期'};
 function lock(){epoch++;token='';$('admin').value='';$('secret').value='';$('secret').type='password';$('secret-area').hidden=true;$('controls').hidden=true;$('keys').replaceChildren();say('已锁定；页面中的密钥已清空。');}
 async function request(body){
  if(busy)throw Error('BUSY');busy=true;const owner=epoch;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
   const res=await fetch('/api/admin/keys',{method:body?'POST':'GET',headers:{'X-Admin-Token':token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store',redirect:'error',signal:controller.signal});
   const out=await res.json();if(owner!==epoch)throw Error('LOCKED');if(!res.ok)throw Error(out.error?.code||'REQUEST_FAILED');return out;
  }finally{clearTimeout(timer);busy=false;}
 }
 async function refresh(){const out=await request();$('keys').replaceChildren();for(const key of out.keys){const row=document.createElement('tr');for(const [index,value] of [key.label,key.scopes.map(s=>labels[s]||s).join('、'),labels[key.status]||key.status,key.expires_at_ms?new Date(key.expires_at_ms).toLocaleString('zh-CN',{hour12:false,timeZoneName:'short'}):'无固定期限'].entries()){const td=document.createElement('td');td.dataset.label=['名称','权限','状态','到期时间'][index];td.textContent=value;row.append(td);}const actions=document.createElement('td');actions.dataset.label='操作';for(const [action,label] of [['rotate','轮换'],['revoke','撤销']]){if(action==='rotate'&&key.status!=='active'||action==='revoke'&&key.status==='revoked')continue;const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',()=>change(action,key));actions.append(b);}row.append(actions);$('keys').append(row);}$('controls').hidden=false;}
 function showSecret(out){if(!out.secret)return;$('secret').value=out.secret;$('secret').type='password';$('secret-area').hidden=false;$('secret').focus();}
 function failed(e){if(e.message==='LOCKED')return;say('操作失败：'+(e.name==='AbortError'?'请求超时':e.message));}
 async function change(action,key){if(!confirm((action==='rotate'?'轮换后旧密钥将在24小时后失效：':'撤销同一轮换系列的所有密钥：')+key.label))return;try{const out=await request({action,id:key.id});showSecret(out);await refresh();say(action==='rotate'?'已轮换。请保存新密钥并更新调用端。':'已撤销。');}catch(e){failed(e);}}
 $('unlock').addEventListener('submit',async e=>{e.preventDefault();if(location.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(location.hostname)){say('公网密钥管理必须使用 HTTPS。');return;}token=$('admin').value;$('admin').value='';epoch++;try{await refresh();say('已解锁。管理员密钥只保留在当前页面内存中。');}catch(e){lock();failed(e);}});
 $('create').addEventListener('submit',async e=>{e.preventDefault();const scopes=[...document.querySelectorAll('input[name=scope]:checked')].map(x=>x.value);if(!scopes.length){say('请至少选择一种权限。');return;}try{const out=await request({action:'create',label:$('label').value.trim(),scopes});showSecret(out);await refresh();say('创建成功。请保存新密钥。');}catch(e){failed(e);}});
 $('lock').addEventListener('click',lock);$('reveal').addEventListener('click',()=>{$('secret').type=$('secret').type==='password'?'text':'password';});
 $('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('secret').value);say('已复制；请存入私有配置文件。');}catch{say('浏览器不允许复制，请显示后手动复制。');}});
 addEventListener('pagehide',lock);
})();

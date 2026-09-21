(() => {
  // The administrator secret is held in memory only, never local/session storage.
  function createAdminControl({document,button,status,onRetry=()=>{}}={}) {
    let token='',dialog=null,input=null,opener=null;
    const messages={saving:'正在保存后台自选…',saved:'后台自选已保存','auth-required':'本地已保存；后台同步需要管理密钥',retrying:'本地已保存；正在等待重试',failed:'本地已保存；后台同步失败，请重试',invalid:'后台未接受自选，请检查请求',idle:'管理密钥仅在本次页面会话有效'};
    function close(){if(!dialog)return;input.value='';dialog.close();opener?.focus();}
    function show(){
      if(!dialog){
        dialog=document.createElement('dialog');dialog.className='admin-dialog';dialog.setAttribute('aria-labelledby','admin-title');
        dialog.innerHTML='<h2 id="admin-title">后台自选同步</h2><p>管理密钥用于保存服务器自选。只读智能体密钥不能用于写入。密钥只保留在当前页面内存中，刷新页面后需要重新输入。</p><form><label for="admin-key">管理密钥（STATS_TOKEN）</label><input id="admin-key" type="password" autocomplete="off" spellcheck="false" maxlength="1024"><p class="admin-status" role="status"></p><div class="detail-actions"><button type="submit">应用并重试</button><button type="button" data-clear>清除密钥</button><button type="button" data-close>关闭</button></div></form>';
        document.body.appendChild(dialog);input=dialog.querySelector('input');
        dialog.querySelector('form').addEventListener('submit',event=>{event.preventDefault();token=input.value.trim();input.value='';dialog.querySelector('.admin-status').textContent=token?'密钥已保留在当前页面，正在重试同步。':'未设置密钥，仅允许直连本机的写入。';onRetry();});
        dialog.querySelector('[data-clear]').addEventListener('click',()=>{token='';input.value='';dialog.querySelector('.admin-status').textContent='当前页面中的密钥已清除。';});
        dialog.querySelector('[data-close]').addEventListener('click',close);
        dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
      }
      opener=document.activeElement;dialog.showModal();input.focus();
    }
    button?.addEventListener('click',show);
    return Object.freeze({getToken:()=>token,show,clear(){token='';if(input)input.value='';},setStatus(value){if(status){status.textContent=messages[value.state]||messages.idle;status.dataset.state=value.state;}if(button)button.dataset.pending=String(!!value.pending);}});
  }
  window.PANEL_ADMIN=Object.freeze({createAdminControl});
})();

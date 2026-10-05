(() => {
  // Owns modal navigation, focus and scroll restoration, independently of data.
  function createDetailDialog({document,window,onBack}){
    let dialog=null,opener=null,overflow='',pushed=false;
    const pop=()=>{if(dialog)onBack();};
    function open(element,focus){
      dialog=element;opener=focus||document.activeElement;overflow=document.body.style.overflow;
      document.body.style.overflow='hidden';dialog.showModal();
      history.pushState({chartDetail:true},'',location.href);pushed=true;
      window.addEventListener('popstate',pop);
    }
    function close(fromPop=false){
      if(!dialog)return;
      const element=dialog;dialog=null;window.removeEventListener('popstate',pop);
      if(document.fullscreenElement===element)void document.exitFullscreen?.().catch(()=>{});
      try{window.screen?.orientation?.unlock?.();}catch{}
      element.close();document.body.style.overflow=overflow;opener?.focus?.();opener=null;
      if(pushed&&!fromPop)history.back();pushed=false;
    }
    return Object.freeze({open,close});
  }
  window.PANEL_DETAIL_DIALOG=Object.freeze({createDetailDialog});
})();

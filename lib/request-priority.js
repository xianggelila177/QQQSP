// Roles describe the reader, not the endpoint. Explicit history pagination is
// foreground; automatic quote refresh is normal; watchlist prewarm is background.
// Legacy numeric 1 remains high and 0/unknown remain normal.
const handles=new WeakMap();
export function requestPriority(role){
 const handle=handles.get(role);if(handle)return handle.value;
 if(role==='foreground'||role===1)return 2;
 if(role==='background'||role==='prewarm')return 0;
 return 1;
}

// Shared producers inherit the highest role of any joining reader. The same
// handle follows the producer through nested queues; it never preempts work.
export function createPriorityHandle(role){
 const state={value:requestPriority(role),listeners:new Set()};
 const handle=Object.freeze({promote(next){
  const value=requestPriority(next);if(value<=state.value)return;
  state.value=value;for(const listener of [...state.listeners])listener(value);
 }});
 handles.set(handle,state);return handle;
}
export function observePriority(role,listener){
 const state=handles.get(role);if(!state)return null;
 state.listeners.add(listener);return ()=>state.listeners.delete(listener);
}

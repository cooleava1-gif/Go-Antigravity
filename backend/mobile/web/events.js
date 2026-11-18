// Finite event requests avoid proxy buffering while the server retains one native desktop stream.
export function createEventStream({onStatus,onSessions,onSnapshot,onSyncError,onMode,probeAuth,poll,blocked}) {
 let controller=null,session=null,generation=0,failures=0,retryTimer=0,pollTimer=0,polling=false,stopped=true,cursor='';
 function stopPolling(){clearTimeout(pollTimer);pollTimer=0;polling=false;}
 function startPolling(){if(polling||stopped||blocked())return;polling=true;onMode('polling');const tick=async()=>{if(!polling||stopped||blocked())return;try{await poll();}catch{}if(polling&&!stopped&&!blocked())pollTimer=setTimeout(tick,document.hidden?10000:1500);};void tick();}
 function close(){clearTimeout(retryTimer);controller?.abort();controller=null;}
 function stop(){stopped=true;generation++;close();stopPolling();onMode('stopped');}
 async function open(version){
  if(stopped||blocked()||version!==generation)return;const request=new AbortController();controller=request;const timeout=setTimeout(()=>request.abort(),25000),current=()=>!stopped&&!blocked()&&version===generation&&controller===request;
  try{
   const query=new URLSearchParams();if(session)query.set('session',session);if(cursor)query.set('cursor',cursor);
   const response=await fetch('/agy-pocket/api/live?'+query,{signal:request.signal,cache:'no-store',credentials:'same-origin',headers:{accept:'application/json'}});
   if(!current())return;
   if(response.status===401){onSyncError({status:401,error:'身份验证已失效，请重新验证。'});stop();return;}
   if(!response.ok)throw Error('实时同步暂时不可用');const result=await response.json();if(!current())return;if(!Array.isArray(result.events)||typeof result.cursor!=='string')throw Error('实时数据格式不正确');cursor=result.cursor;failures=0;stopPolling();
   for(const {event,data} of result.events){if(!current())return;if(event==='status')onStatus(data);else if(event==='sessions')onSessions(data);else if(event==='snapshot')onSnapshot(data,session);else if(event==='sync-error')onSyncError(data);else if(event==='ready')onMode(data.transport==='fallback'?'polling':'live');}
   if(current())retryTimer=setTimeout(()=>open(version),0);
  }catch(error){if(!current())return;failures++;if(failures>=3)startPolling();else onMode('connecting');retryTimer=setTimeout(async()=>{if(!current())return;try{await probeAuth();}catch{}if(current())open(version);},Math.min(30000,1000*2**Math.min(failures,5)));}
  finally{clearTimeout(timeout);}
 }
 function connect(id,force=false){const next=id||null;if(!force&&!stopped&&next===session)return;close();stopPolling();session=next;cursor='';stopped=false;failures=0;generation++;onMode('connecting');void open(generation);}
 return {connect,stop,retry(){connect(session,true);},get active(){return !!controller&&!stopped;}};
}

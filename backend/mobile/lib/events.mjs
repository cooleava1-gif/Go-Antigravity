import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
// One native subscription per selected desktop conversation, shared by all phone tabs.
export class EventHub {
 constructor(adapter){this.adapter=adapter;this.clients=new Set();this.channels=new Map();this.timer=null;this.busy=false;this.closed=false;}
 async poll(req,res,id,cursor=''){
  if(this.clients.size>=24){res.writeHead(429,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify({error:'连接过多，请关闭多余页面'}));return;}
  let known={};try{if(cursor.length>2000)throw Error();known=JSON.parse(Buffer.from(cursor,'base64url').toString());if(!known||typeof known!=='object'||Array.isArray(known))known={};}catch{known={};}
  const hashes={},events=[];for(const key of ['status','sessions','snapshot','ready','sync-error'])if(typeof known[key]==='string')hashes[key]=known[key];
  const virtual=new EventEmitter(),input=new EventEmitter();let pending='',done=false,flushTimer,timeout;
  const finish=()=>{if(done)return;done=true;clearTimeout(flushTimer);clearTimeout(timeout);virtual.end();if(!res.destroyed&&!res.writableEnded){res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify({events,cursor:Buffer.from(JSON.stringify(hashes)).toString('base64url')}));}};
  Object.assign(virtual,{destroyed:false,writableEnded:false,writableLength:0,writeHead(){},flushHeaders(){},write(text){pending+=text;let at;while((at=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,at);pending=pending.slice(at+2);const name=frame.match(/^event: (.+)$/m)?.[1],raw=frame.match(/^data: (.+)$/m)?.[1];if(!name||!raw)continue;let data;try{data=JSON.parse(raw);}catch{continue;}if(name==='ready'&&data.transport==='sse'){if(id)continue;data={...data,transport:'native'};}const hash=createHash('sha256').update(raw).digest('hex').slice(0,20);if(hashes[name]===hash)continue;hashes[name]=hash;events.push({event:name,data});if(!flushTimer)flushTimer=setTimeout(finish,20);}return true;},end(){if(this.writableEnded)return;this.writableEnded=true;this.emit('close');},destroy(){this.destroyed=true;this.end();}});
  const abort=()=>{done=true;clearTimeout(flushTimer);clearTimeout(timeout);virtual.destroy();};req.once('aborted',abort);res.once('close',abort);timeout=setTimeout(finish,18000);
  try{await this.attach(input,virtual,id);}catch(e){abort();throw e;}
 }
 async attach(req,res,id){
  if(this.closed)throw Error('服务正在关闭');
  if(this.clients.size>=24){res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:'连接过多，请关闭多余页面'}));return;}
  if(id)await this.adapter.session(id); // Validate desktop ownership before opening a long-lived stream.
  if(this.closed||req.aborted||res.destroyed)return;
  res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-store, no-transform','connection':'keep-alive','x-accel-buffering':'no','x-content-type-options':'nosniff'});
  res.flushHeaders?.();res.write('retry: 1500\n\n');
  const client={res,id,last:new Map(),closed:false};
  const emit=(name,value,force=false)=>this.emit(client,name,value,force);
  client.emit=emit;this.clients.add(client);
  const close=()=>{if(client.closed)return;client.closed=true;clearInterval(client.heartbeat);this.clients.delete(client);if(id){const ch=this.channels.get(id);ch?.clients.delete(client);if(ch&&!ch.clients.size){ch.releaseTimer=setTimeout(()=>{if(!ch.clients.size){ch.controller.abort();this.channels.delete(id);}},2000);ch.releaseTimer.unref?.();}}if(!this.clients.size){clearInterval(this.timer);this.timer=null;}if(!res.writableEnded)res.end();};
  res.once('close',close);req.once('aborted',close);
  client.heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n');},15000);client.heartbeat.unref?.();
  emit('ready',{transport:'sse',session:id||null});
  if(id){let ch=this.channels.get(id);if(!ch){ch={clients:new Set(),controller:new AbortController(),snapshot:null};this.channels.set(id,ch);}clearTimeout(ch.releaseTimer);ch.clients.add(client);if(ch.snapshot){emit('snapshot',ch.snapshot);emit('ready',{transport:ch.transport||'native',session:id});}if(!ch.started){ch.started=true;void this.runChannel(id,ch);}}
  if(!this.timer){this.timer=setInterval(()=>void this.refresh(),5000);this.timer.unref?.();}
  void this.refresh(client);
 }
 emit(client,name,value,force=false){
  const {res}=client;if(client.closed||res.destroyed||res.writableEnded)return;
  const data=JSON.stringify(value);if(!force&&client.last.get(name)===data)return;client.last.set(name,data);
  // Bound memory for a stalled mobile connection. EventSource will reconnect with a fresh snapshot.
  if(res.writableLength>2*1024*1024){res.destroy();return;}
  res.write('event: '+name+'\ndata: '+data+'\n\n');
 }
 async refresh(only){
  if(this.busy){if(only){const cached=this.cached;if(cached){only.emit('status',cached.status);only.emit('sessions',cached.sessions);}}return;}
  this.busy=true;try{const [status,sessions]=await Promise.all([this.adapter.status(),this.adapter.sessions()]);this.cached={status,sessions};for(const c of this.clients){c.emit('status',status);c.emit('sessions',sessions);}}catch(e){for(const c of this.clients)c.emit('sync-error',{error:e.message||'会话同步暂不可用',status:e.status||503});}finally{this.busy=false;}
 }
 async runChannel(id,ch){
  while(!ch.controller.signal.aborted){
   try{
    await this.adapter.watchSession(id,snapshot=>{ch.snapshot=snapshot;ch.transport='native';for(const c of ch.clients){c.emit('snapshot',snapshot);c.emit('ready',{transport:'native',session:id});}},ch.controller.signal);
    if(!ch.controller.signal.aborted)throw Error('桌面输出流已断开');
   }catch(e){
    if(ch.controller.signal.aborted)break;
    for(const c of ch.clients)c.emit('sync-error',{error:e.message||'桌面连接中断，正在重连',status:e.status||503});
    // Keep usable snapshots while retrying the native desktop subscription.
    for(let n=0;n<3&&!ch.controller.signal.aborted;n++){
     try{const snapshot=await this.adapter.session(id);ch.snapshot=snapshot;ch.transport='fallback';for(const c of ch.clients){c.emit('snapshot',snapshot);c.emit('ready',{transport:'fallback',session:id});}}catch{}
     try{await delay(1500,undefined,{signal:ch.controller.signal});}catch{}
    }
   }
  }
 }
 dispose(){this.closed=true;clearInterval(this.timer);for(const ch of this.channels.values()){clearTimeout(ch.releaseTimer);ch.controller.abort();}for(const c of this.clients){clearInterval(c.heartbeat);c.res.end();}this.channels.clear();this.clients.clear();}
}

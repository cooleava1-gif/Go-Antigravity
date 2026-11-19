import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createMobileServer } from '../mobile/server.mjs';
import { constantTimeEqual, createAuth } from '../mobile/lib/auth.mjs';
import WebSocket, { WebSocketServer } from 'ws';
import { LOCAL_URL, parseQuickUrl, parseFixedUrl, parseRuntimeOptions, buildCloudflaredArgs, createLineReader, quickUrlFromLine, createTunnelSupervisor, cloudflaredEnvironment, validateExternalConfig } from '../mobile/tunnel.mjs';

const immediate = () => new Promise(resolve => setImmediate(resolve));
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + server.address().port; }
function http(base, path, { method='GET', headers={}, body }={}) {
 return new Promise((resolve,reject) => { const req=request(base+path,{method,headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end(body); });
}
function upgrade(base, cookie='') {
 return new Promise((resolve,reject)=>{const url=new URL(base),socket=connect(Number(url.port),'127.0.0.1');let text='';socket.on('error',reject);socket.on('data',c=>{text+=c;if(text.includes('\r\n\r\n')){socket.destroy();resolve(text);}});socket.on('connect',()=>socket.write('GET /ws HTTP/1.1\r\nHost: '+url.host+'\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'+(cookie?'Cookie: '+cookie+'\r\n':'')+'\r\n'));});
}

test('quick URL accepts exact bare Cloudflare HTTPS origins only',()=>{
 assert.equal(parseQuickUrl('https://random-123.trycloudflare.com'),'https://random-123.trycloudflare.com');
 for(const bad of ['https://api.trycloudflare.com','http://a.trycloudflare.com','https://A.trycloudflare.com','https://a.trycloudflare.com/','https://a.trycloudflare.com:443','https://a.trycloudflare.com?q=x','https://u@a.trycloudflare.com','https://a.trycloudflare.com.evil.test','https://a.trycloudflare.com#x',' https://a.trycloudflare.com','https://a.trycloudflare.com\n']) assert.equal(parseQuickUrl(bad),null,bad);
 assert.equal(quickUrlFromLine('| https://test-url.trycloudflare.com |'),'https://test-url.trycloudflare.com');
 assert.equal(quickUrlFromLine('https://test.trycloudflare.com/private'),null);
 assert.equal(quickUrlFromLine('https://secret@valid.trycloudflare.com'),null);
 assert.equal(quickUrlFromLine('registering https://api.trycloudflare.com'),null);
});
test('fixed URL and mode validation reject unsafe configuration',()=>{
 assert.equal(parseFixedUrl('https://mobile.example.com/'),'https://mobile.example.com');
 for(const bad of ['http://example.com','https://localhost','https://127.0.0.1','https://[::1]','https://host.local','https://u:p@example.com','https://example.com/a','https://example.com?x','https://example.com:443','https://example.com#x','https://example.com\\evil',' HTTPS://example.com']) assert.throws(()=>parseFixedUrl(bad));
 assert.deepEqual(parseRuntimeOptions({}),{mode:'quick',publicUrl:null,config:null});
 assert.throws(()=>parseRuntimeOptions({GO_ANTIGRAVITY_MOBILE_MODE:'other'}));
 assert.throws(()=>parseRuntimeOptions({GO_ANTIGRAVITY_MOBILE_MODE:'fixed',GO_ANTIGRAVITY_MOBILE_FIXED_URL:'https://mobile.example.com'}),/FIXED_CONFIG_REQUIRED/);
 const env={GO_ANTIGRAVITY_MOBILE_MODE:'fixed',GO_ANTIGRAVITY_MOBILE_FIXED_URL:'https://mobile.example.com',GO_ANTIGRAVITY_MOBILE_CF_CONFIG:process.platform==='win32'?'C:/outside/tunnel.yaml':'/outside/tunnel.yaml'};
 assert.equal(parseRuntimeOptions(env).mode,'fixed');
 assert.throws(()=>parseRuntimeOptions({...env,GO_ANTIGRAVITY_MOBILE_CF_CONFIG:'relative.yml'}));
});
test('CLI ordering isolates quick config and keeps fixed run after all tunnel flags',()=>{
 const quick=buildCloudflaredArgs({mode:'quick'}); assert.equal(quick[0],'tunnel');assert.equal(quick[1],'--config');assert.match(quick[2],/quick-config.yml$/);assert.ok(quick.includes(LOCAL_URL));assert.equal(quick.includes('run'),false);
 assert.deepEqual(buildCloudflaredArgs({mode:'fixed',config:'/external/tunnel.yml'}),['tunnel','--config','/external/tunnel.yml','--metrics','127.0.0.1:20382','--no-autoupdate','--protocol','http2','run']);
 assert.deepEqual(cloudflaredEnvironment({PATH:'bin',TUNNEL_CONFIG:'secret',TUNNEL_TOKEN:'secret',CF_TUNNEL:'secret',GO_ANTIGRAVITY_MOBILE_PIN:'12345678'},'quick'),{PATH:'bin'});
});
test('external named configuration cannot live inside the repository',async()=>{
 await assert.rejects(validateExternalConfig(new URL('../mobile/quick-config.yml',import.meta.url)),/FIXED_CONFIG_REQUIRED/);
});
test('bounded output parser drops giant lines and never accepts partial URL suffixes',()=>{
 const found=[],reader=createLineReader(line=>found.push(line),100);
 reader.push('x'.repeat(100000));assert.equal(reader.bufferedLength,0);reader.push('https://evil.trycloudflare.com\n');reader.push('| https://okay.trycloud');reader.push('flare.com |\n');reader.end();
 assert.deepEqual(found,['| https://okay.trycloudflare.com |']);
});
test('constant-time comparison uses buffer byte length',()=>{assert.equal(constantTimeEqual('é','aa'),false);assert.equal(constantTimeEqual('a','é'),false);assert.equal(constantTimeEqual('12345678','12345678'),true);assert.equal(constantTimeEqual(null,''),false);});

test('guest and expired browser deep links reopen PIN login while APIs stay unauthorized',async(t)=>{
 let discoveries=0,now=0;
 const runtime=createMobileServer({pin:'12345678',adapter:{discover:async()=>{discoveries++;throw Error('must not discover');}},now:()=>now}),base=await listen(runtime.server);t.after(()=>runtime.close());
 for(const path of ['/mobile','/mobile/','/c/saved-conversation']){
  const response=await http(base,path);assert.equal(response.status,200,path);assert.match(response.headers['content-type'],/text\/html/);assert.match(response.body,/action="\/pocket-login"/);assert.equal(response.headers['cache-control'],'no-store');
 }
 const navigation=await http(base,'/saved-page',{headers:{'sec-fetch-dest':'document',accept:'text/html'}});assert.equal(navigation.status,200);assert.match(navigation.body,/pocket-login/);
 const head=await http(base,'/mobile/',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.body,'');
 for(const path of ['/mobile/api/status','/api/private','/assets/app.js']){const response=await http(base,path,{headers:{accept:'application/json'}});assert.equal(response.status,401,path);assert.match(response.headers['content-type'],/application\/json/);}
 assert.equal((await http(base,'/c/saved-conversation',{method:'POST'})).status,401);
 const login=await http(base,'/pocket-login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'token=12345678'}),cookie=login.headers['set-cookie'][0].split(';')[0];
 now=13*60*60*1000;
 const expired=await http(base,'/mobile/',{headers:{cookie}});assert.equal(expired.status,200);assert.match(expired.body,/action="\/pocket-login"/);
 assert.equal((await http(base,'/mobile/api/status',{headers:{cookie}})).status,401);assert.equal(discoveries,0);
});
test('compatibility authentication recovery links point to the PIN page',async()=>{
 const html=await readFile(new URL('../mobile/web/index.html',import.meta.url),'utf8'),source=await readFile(new URL('../mobile/web/app.js',import.meta.url),'utf8');
 assert.match(html,/id="authLink" href="\/pocket-login"/);assert.match(source,/action==='auth'\)location\.assign\('\/pocket-login'\)/);
});

test('guest/login/native/compatibility/WS authentication and 12-hour renewal',async(t)=>{
 let discovery=0,now=0;
 const upstream=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('native-ok');});
 upstream.on('upgrade',(_req,socket)=>{socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');});
 const nativeBase=await listen(upstream);t.after(()=>new Promise(resolve=>upstream.close(resolve)));
 const adapter={discover:async()=>{discovery++;return{base:nativeBase,token:'native-test-only'};},status:async()=>({connected:true}),sessions:async()=>({sessions:[]})};
 const runtime=createMobileServer({pin:'12345678',adapter,now:()=>now}),base=await listen(runtime.server);t.after(()=>runtime.close());
 const guest=await http(base,'/');assert.equal(guest.status,200);assert.match(guest.body,/pocket-login/);assert.equal(discovery,0);
 assert.equal((await http(base,'/api/private')).status,401);assert.equal((await http(base,'/mobile/api/status?token=12345678')).status,401);
 assert.ok((await upgrade(base)).startsWith('HTTP/1.1 401'));assert.equal(discovery,0);
 assert.equal((await http(base,'/pocket-login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'token=invalid1'})).status,401);
 const login=()=>http(base,'/pocket-login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-forwarded-proto':'https'},body:'token=12345678'});
 const logged=await login();assert.equal(logged.status,302);assert.equal(logged.headers.location,'/');assert.match(logged.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/);assert.match(logged.headers['set-cookie'][0],/; Secure/);
 let cookie=logged.headers['set-cookie'][0].split(';')[0];
 assert.equal((await http(base,'/?wsTransport=3',{headers:{cookie}})).body,'native-ok');
 assert.equal((await http(base,'/mobile/',{headers:{cookie}})).status,200);
 assert.equal((await http(base,'/mobile/api/status',{headers:{cookie}})).status,200);
 assert.ok((await upgrade(base,cookie)).startsWith('HTTP/1.1 101'));
 now=13*60*60*1000;assert.equal((await http(base,'/mobile/api/status',{headers:{cookie}})).status,401);
 const renewed=await login();cookie=renewed.headers['set-cookie'][0].split(';')[0];assert.equal((await http(base,'/mobile/api/status',{headers:{cookie}})).status,200);
});
test('browser form keeps a same-origin Origin while opaque and foreign origins stay blocked',async(t)=>{
 const runtime=createMobileServer({pin:'12345678',adapter:{}}),base=await listen(runtime.server);t.after(()=>runtime.close());
 const host='sample-public.trycloudflare.com',origin='https://'+host;
 const guest=await http(base,'/',{headers:{host}});assert.equal(guest.headers['referrer-policy'],'same-origin');
 const post=(value)=>http(base,'/pocket-login',{method:'POST',headers:{host,origin:value,'sec-fetch-site':'same-origin','content-type':'application/x-www-form-urlencoded','x-forwarded-proto':'https'},body:'token=12345678'});
 assert.equal((await post('null')).status,403);assert.equal((await post('https://evil.example')).status,403);
 const logged=await post(origin);assert.equal(logged.status,302);assert.match(logged.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/);assert.match(logged.headers['set-cookie'][0],/; Secure/);
});
test('wrong PIN rate limit, body limits and cross-site login protection',async(t)=>{
 const runtime=createMobileServer({pin:'12345678',adapter:{}}),base=await listen(runtime.server);t.after(()=>runtime.close());
 const attempt=(body,extra={})=>http(base,'/pocket-login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...extra},body});
 assert.equal((await attempt('token=12345678',{origin:'https://evil.example'})).status,403);
 assert.equal((await attempt('token='+'a'.repeat(5000))).status,413);
 for(let i=0;i<5;i++)assert.equal((await attempt('token=wrongpin')).status,401);
 assert.equal((await attempt('token=12345678')).status,429);
});

function fakeSessionClock() {
 let time=0;const pending=new Map();
 const timers={setTimeout(fn,delay){const handle={unref(){return this;}};pending.set(handle,{fn,at:time+delay});return handle;},clearTimeout(handle){pending.delete(handle);}};
 return {now:()=>time,timers,pending,advance(ms){time+=ms;for(const [handle,task] of [...pending])if(task.at<=time){pending.delete(handle);task.fn();}}};
}
async function loginCookie(base) {
 const result=await http(base,'/pocket-login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'token=12345678'});
 assert.equal(result.status,302);return result.headers['set-cookie'][0].split(';')[0];
}
async function concurrentLogins(runtime,base,count,headersFor=()=>({})) {
 let arrived=0,ready;const barrier=new Promise(resolve=>{ready=resolve;});
 const observe=req=>{if(new URL(req.url,'http://localhost').pathname==='/pocket-login'&&++arrived===count)ready();};
 runtime.server.on('request',observe);
 const clients=[],results=[];
 for(let i=0;i<count;i++)results.push(new Promise((resolve,reject)=>{
  const body='token=incorrect',req=request(base+'/pocket-login',{method:'POST',agent:false,headers:{'content-type':'application/x-www-form-urlencoded','content-length':Buffer.byteLength(body),...headersFor(i)}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});
  req.once('error',reject);req.flushHeaders();clients.push({req,body});
 }));
 try {await barrier;for(const {req,body} of clients)req.end(body);return await Promise.all(results);}
 finally {runtime.server.off('request',observe);for(const {req} of clients)req.destroy();}
}
function openStream(base,path,cookie) {
 return new Promise((resolve,reject)=>{
  const req=request(base+path,{agent:false,headers:{cookie}},res=>{
   const closed=new Promise(done=>res.once('close',done));res.on('error',()=>{});
   res.once('data',()=>resolve({req,res,closed}));res.resume();
  });req.once('error',reject);req.end();
 });
}
async function websocketPair(base,wss,cookie) {
 const peer=new Promise(resolve=>wss.once('connection',resolve));
 const client=new WebSocket(base.replace('http:','ws:')+'/ws',{headers:{cookie}});
 client.on('error',()=>{});await new Promise((resolve,reject)=>{client.once('open',resolve);client.once('error',reject);});
 const upstream=await peer;upstream.on('error',()=>{});return {client,upstream};
}
async function eventually(check) {for(let i=0;i<40;i++){if(check())return;await immediate();}assert.ok(check(),'cleanup should complete');}

test('concurrent unfinished login bodies enforce five failures per IP and reset at the current window',async(t)=>{
 const clock=fakeSessionClock(),runtime=createMobileServer({pin:'12345678',adapter:{},now:clock.now,sessionTimers:clock.timers}),base=await listen(runtime.server);t.after(()=>runtime.close());
 const statuses=await concurrentLogins(runtime,base,120);
 assert.equal(statuses.filter(s=>s===401).length,5);assert.equal(statuses.filter(s=>s===429).length,115);
 assert.equal((await http(base,'/pocket-login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'token=12345678'})).status,429);
 clock.advance(60000);await loginCookie(base);
 assert.equal((await http(base,'/pocket-login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'token=incorrect'})).status,401);
});
test('concurrent forwarded IPs share the global hundred-failure limit and recover after one minute',async(t)=>{
 const clock=fakeSessionClock(),runtime=createMobileServer({pin:'12345678',adapter:{},now:clock.now,sessionTimers:clock.timers}),base=await listen(runtime.server);t.after(()=>runtime.close());
 const statuses=await concurrentLogins(runtime,base,120,i=>({'cf-connecting-ip':'192.0.2.'+(i+1)}));
 assert.equal(statuses.filter(s=>s===401).length,100);assert.equal(statuses.filter(s=>s===429).length,20);
 assert.equal((await http(base,'/pocket-login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','cf-connecting-ip':'198.51.100.1'},body:'token=12345678'})).status,429);
 clock.advance(60000);await loginCookie(base);
});
test('malformed login bodies consume failures while cross-site, unsupported and oversized bodies keep their status',async(t)=>{
 const runtime=createMobileServer({pin:'12345678',adapter:{}}),base=await listen(runtime.server);t.after(()=>runtime.close());
 const post=(body,headers={})=>http(base,'/pocket-login',{method:'POST',headers:{'content-type':'application/json',...headers},body});
 assert.equal((await post('{}',{'sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await post('',{'content-type':'text/plain'})).status,415);
 assert.equal((await post('x'.repeat(4097))).status,413);
 for(let i=0;i<5;i++)assert.equal((await post('{')).status,400);
 assert.equal((await post('{')).status,429);
});
test('session expiry actively closes both WS peers, native HTTP streams and compatibility SSE, then permits renewal', {timeout:10000},async(t)=>{
 const clock=fakeSessionClock(),upstreamCookies=[],upstreamResponses=[];
 const upstream=createServer((req,res)=>{upstreamCookies.push(req.headers.cookie||'');upstreamResponses.push(res);res.writeHead(200,{'content-type':'text/plain'});res.write('live');});
 const wss=new WebSocketServer({server:upstream});wss.on('connection',(peer,req)=>{upstreamCookies.push(req.headers.cookie||'');peer.on('message',data=>peer.send(data));});
 const nativeBase=await listen(upstream);t.after(async()=>{for(const peer of wss.clients)peer.terminate();for(const res of upstreamResponses)res.destroy();wss.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));});
 const adapter={discover:async()=>({base:nativeBase,token:'synthetic-native'}),status:async()=>({connected:true}),sessions:async()=>({sessions:[]})};
 const runtime=createMobileServer({pin:'12345678',adapter,now:clock.now,sessionTimers:clock.timers}),base=await listen(runtime.server);t.after(()=>runtime.close());
 const cookie=await loginCookie(base),pair=await websocketPair(base,wss,cookie);
 const echoed=new Promise(resolve=>pair.client.once('message',data=>resolve(data.toString())));pair.client.send('synthetic-message');assert.equal(await echoed,'synthetic-message');
 const pushed=new Promise(resolve=>pair.client.once('message',data=>resolve(data.toString())));pair.upstream.send('synthetic-push');assert.equal(await pushed,'synthetic-push');
 const native=await openStream(base,'/stream',cookie),sse=await openStream(base,'/mobile/api/events',cookie);
 const clientClosed=new Promise(resolve=>pair.client.once('close',resolve)),peerClosed=new Promise(resolve=>pair.upstream.once('close',resolve)),nativeClosed=new Promise(resolve=>upstreamResponses[0].once('close',resolve));
 assert.equal(clock.pending.size,1);assert.ok(upstreamCookies.every(value=>!value.includes('go_antigravity_mobile_session')));
 clock.advance(12*60*60*1000);
 await Promise.all([clientClosed,peerClosed,native.closed,sse.closed,nativeClosed]);
 assert.equal(clock.pending.size,0);assert.equal(pair.client.readyState,WebSocket.CLOSED);assert.equal(pair.upstream.readyState,WebSocket.CLOSED);
 assert.equal((await http(base,'/mobile/api/status',{headers:{cookie}})).status,401);assert.ok((await upgrade(base,cookie)).startsWith('HTTP/1.1 401'));
 const renewed=await loginCookie(base);assert.equal((await http(base,'/mobile/api/status',{headers:{cookie:renewed}})).status,200);
});
test('closed resources clear expiry timers and direct server.close disconnects active upgraded sockets', {timeout:10000},async(t)=>{
 const clock=fakeSessionClock(),upstream=createServer(),wss=new WebSocketServer({server:upstream}),nativeBase=await listen(upstream);
 t.after(async()=>{for(const peer of wss.clients)peer.terminate();wss.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));});
 const runtime=createMobileServer({pin:'12345678',adapter:{discover:async()=>({base:nativeBase,token:'synthetic-native'})},now:clock.now,sessionTimers:clock.timers}),base=await listen(runtime.server);t.after(()=>runtime.close());
 const cookie=await loginCookie(base),first=await websocketPair(base,wss,cookie);assert.equal(clock.pending.size,1);
 const firstClosed=new Promise(resolve=>first.upstream.once('close',resolve));first.client.terminate();await firstClosed;await eventually(()=>clock.pending.size===0);
 const second=await websocketPair(base,wss,cookie),closed=new Promise(resolve=>second.client.once('close',resolve)),peerClosed=new Promise(resolve=>second.upstream.once('close',resolve));assert.equal(clock.pending.size,1);
 await new Promise(resolve=>runtime.server.close(resolve));await Promise.all([closed,peerClosed]);assert.equal(clock.pending.size,0);
});
test('session eviction revokes bound resources and dispose cancels timers without retaining listeners',async()=>{
 const clock=fakeSessionClock(),auth=createAuth({pin:'12345678',now:clock.now,timers:clock.timers});
 async function login(){const req=new PassThrough();req.method='POST';req.headers={'content-type':'application/x-www-form-urlencoded'};req.socket={remoteAddress:'127.0.0.1'};let cookie;
  const res={writableEnded:false,destroyed:false,writeHead(_status,headers){cookie=headers['set-cookie']?.split(';')[0];},end(){this.writableEnded=true;}};
  const promise=auth.login(req,res);req.end('token=12345678');await promise;return cookie;
 }
 const cookie=await login(),resource=new EventEmitter();resource.destroy=()=>{resource.destroyed=true;resource.emit('close');};
 assert.equal(auth.authorize({headers:{cookie}},resource),true);assert.equal(clock.pending.size,1);
 for(let i=0;i<32;i++)await login();
 assert.equal(resource.destroyed,true);assert.equal(resource.listenerCount('close'),0);assert.equal(resource.listenerCount('finish'),0);assert.equal(clock.pending.size,0);assert.equal(auth.authorize({headers:{cookie}}),false);
 const current=await login(),next=new EventEmitter();next.destroy=()=>{next.destroyed=true;next.emit('close');};auth.authorize({headers:{cookie:current}},next);
 assert.equal(clock.pending.size,1);auth.dispose();auth.dispose();assert.equal(next.destroyed,true);assert.equal(clock.pending.size,0);assert.equal(auth.authorize({headers:{cookie:current}}),false);
});

class Child extends EventEmitter {
 constructor(pid){super();this.pid=pid;this.stdout=new PassThrough();this.stderr=new PassThrough();this.exitCode=null;this.signalCode=null;this.kills=[];}
 kill(signal){this.kills.push(signal);this.signalCode=signal;queueMicrotask(()=>this.emit('exit',null,signal));return true;}
 die(){this.exitCode=1;this.emit('exit',1,null);}
}
function fixture(overrides={}) {
 const records=[],children=[],calls=[];let healthy=false;
 const supervisor=createTunnelSupervisor({env:{},checkPorts:async()=>{},checkConfig:async p=>p,resolveBinary:async()=>'/mock/cloudflared',probeReady:async()=>healthy,probePublic:async()=>true,emit:r=>records.push(r),spawnChild:(cmd,args,options)=>{const c=new Child(100+children.length);children.push(c);calls.push({cmd,args,options});return c;},serverTimeout:100,tunnelTimeout:100,pollMs:2,killGrace:5,...overrides});
 return{supervisor,records,children,calls,setHealthy(){healthy=true;},async serverReady(){await immediate();children[0].stdout.write(JSON.stringify({ready:true,local:LOCAL_URL,pin:'12345678',pid:100})+'\n');await immediate();}};
}
test('quick readiness requires exact URL and metrics, emits only sanitized JSON, cleans owned children',async()=>{
 const f=fixture(),start=f.supervisor.start();await f.serverReady();assert.equal(f.children.length,2);
 f.children[1].stderr.write('token=secret https://bad.trycloudflare.com/private\n');await immediate();assert.equal(f.records.some(r=>r.tunnelReady),false);
 f.children[1].stderr.write('| https://random-ok.trycloudflare.com |\n');await immediate();assert.equal(f.records.some(r=>r.tunnelReady),false);
 f.setHealthy();const final=await start;assert.equal(final.publicUrl,'https://random-ok.trycloudflare.com');assert.deepEqual(f.records.find(r=>r.ready),{ready:true,local:LOCAL_URL,pin:'12345678',pid:100});assert.equal(JSON.stringify(f.records).includes('secret'),false);
 await f.supervisor.stop();assert.equal(await f.supervisor.done,0);assert.ok(f.children.every(c=>c.kills.includes('SIGTERM')));
});
test('fixed mode uses configured origin and ignores cloudflared URL output',async()=>{
 const config=process.platform==='win32'?'C:/outside/local.yml':'/outside/local.yml';const f=fixture({env:{GO_ANTIGRAVITY_MOBILE_MODE:'fixed',GO_ANTIGRAVITY_MOBILE_FIXED_URL:'https://mobile.example.com',GO_ANTIGRAVITY_MOBILE_CF_CONFIG:config}}),start=f.supervisor.start();await f.serverReady();f.children[1].stderr.write('https://ignored.trycloudflare.com\n');f.setHealthy();assert.equal((await start).publicUrl,'https://mobile.example.com');assert.equal(f.calls[1].args.at(-1),'run');await f.supervisor.stop();
});
test('fatal child exit cleans sibling and emits canned error',async()=>{
 const f=fixture({retryMs:1}),start=f.supervisor.start();await f.serverReady();f.children[1].die();await new Promise(resolve=>setTimeout(resolve,5));f.children[2].die();await assert.rejects(start,/TUNNEL_START_FAILED/);assert.equal(await f.supervisor.done,1);assert.deepEqual(f.records.at(-1),{error:'TUNNEL_START_FAILED'});assert.ok(f.children[0].kills.length);
});
test('cloudflared missing, startup timeout, invalid fixed mode and cancellation fail cleanly',async()=>{
 for(const opts of [{resolveBinary:async()=>{throw Object.assign(Error('private path'),{code:'CLOUDFLARED_NOT_FOUND'});}},{tunnelTimeout:10},{env:{GO_ANTIGRAVITY_MOBILE_MODE:'fixed'}}]){
  const f=fixture(opts),start=f.supervisor.start(),rejected=assert.rejects(start);if(!opts.env)await f.serverReady();await rejected;await f.supervisor.done;assert.ok(f.records.at(-1).error);assert.equal(JSON.stringify(f.records).includes('private path'),false);
 }
 const f=fixture(),start=f.supervisor.start(),rejected=assert.rejects(start);await immediate();await f.supervisor.stop();await rejected;assert.equal(await f.supervisor.done,0);assert.ok(f.children[0].kills.length);
});
test('compatibility polling fallback starts after three failed finite requests and stops on 401',async()=>{
 const source=await readFile(new URL('../mobile/web/events.js',import.meta.url),'utf8');let fetches=0,polls=0,mode,blocked=false,next=1;const tasks=new Map();
 const context=vm.createContext({AbortController,URLSearchParams,document:{hidden:false},setTimeout(fn,ms){const id=next++;tasks.set(id,{fn,ms});return id;},clearTimeout(id){tasks.delete(id);},fetch:async()=>{fetches++;if(fetches<=3)throw Error('network');return {status:401};}});
 vm.runInContext(source.replace('export function createEventStream','function createEventStream')+';globalThis.createEventStream=createEventStream;',context);
 const stream=context.createEventStream({onStatus(){},onSessions(){},onSnapshot(){},onSyncError(value){if(value.status===401)blocked=true;},onMode:v=>{mode=v;},probeAuth:async()=>{},poll:async()=>{polls++;},blocked:()=>blocked});
 stream.connect(null);await immediate();
 for(let i=0;i<3;i++){const entry=[...tasks].find(([,v])=>v.ms>=2000&&v.ms<=30000);assert.ok(entry);tasks.delete(entry[0]);await entry[1].fn();await immediate();}
 assert.ok(polls>=1);assert.equal(blocked,true);assert.equal(mode,'stopped');assert.equal(tasks.size,0);stream.stop();
});

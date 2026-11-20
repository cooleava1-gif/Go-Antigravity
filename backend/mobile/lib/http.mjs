import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DesktopAdapter, PocketError, checkId } from './desktop.mjs';
import { EventHub } from './events.mjs';
const web=new URL('../web/',import.meta.url);
const assets=new Map([['/mobile/messages.js',['messages.js','text/javascript; charset=utf-8']],['/mobile/events.js',['events.js','text/javascript; charset=utf-8']],['/mobile/',['index.html','text/html; charset=utf-8']],['/mobile/app.js',['app.js','text/javascript; charset=utf-8']],['/mobile/styles.css',['styles.css','text/css; charset=utf-8']]]);
export function json(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));}
async function body(req){let n=0;const chunks=[];for await(const c of req){n+=c.length;if(n>65536)throw new PocketError('消息过长（最大 64KB）',413);chunks.push(c);}try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw new PocketError('JSON 请求无效',400);}}
function message(v){if(typeof v!=='string'||!v.trim())throw new PocketError('请输入消息',400);if(v.length>24000)throw new PocketError('消息过长（最多 24000 字符）',413);return v.trim();}
function trustedOrigin(req){
 const value=req.headers.origin;
 if(value===undefined)return true;
 try{const source=new URL(value);
  if(source.origin!==value||source.host!==String(req.headers.host||'').toLowerCase())return false;
  return source.protocol==='https:'||(source.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(source.hostname));
 }catch{return false;}
}
export function createHandler({adapter=new DesktopAdapter(),authorize=()=>false}={}){
 const hub=new EventHub(adapter);
 const handler=async function handler(req,res){
  const path=new URL(req.url,'http://localhost').pathname;
  try{
   if(!await authorize(req,res)){if(!res.writableEnded)json(res,401,{error:'请先完成 Pocket 登录'});return;}
   if(path==='/mobile'){res.writeHead(302,{location:'/mobile/'});res.end();return;}
   const asset=assets.get(path);if(asset){if(req.method!=='GET'&&req.method!=='HEAD')throw new PocketError('不支持此方法',405);const data=await readFile(new URL(asset[0],web));res.writeHead(200,{'content-type':asset[1],'cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'"});res.end(req.method==='HEAD'?undefined:data);return;}
   if(!path.startsWith('/mobile/api/'))throw new PocketError('入口不存在',404);
   if(req.method==='GET'){
    if(path==='/mobile/api/live'){const url=new URL(req.url,'http://localhost'),id=url.searchParams.get('session');return await hub.poll(req,res,id?checkId(id):null,url.searchParams.get('cursor')||'');}
    if(path==='/mobile/api/events'){const id=new URL(req.url,'http://localhost').searchParams.get('session');return await hub.attach(req,res,id?checkId(id):null);}
    if(path==='/mobile/api/models')return json(res,200,await adapter.models());
    if(path==='/mobile/api/status')return json(res,200,await adapter.status());
    if(path==='/mobile/api/sessions')return json(res,200,await adapter.sessions());
    const m=path.match(/^\/mobile\/api\/sessions\/([^/]+)$/);if(m)return json(res,200,await adapter.session(checkId(m[1])));
   }
   if(req.method==='POST'){
    if(req.headers['x-go-antigravity-mobile']!=='1')throw new PocketError('缺少请求校验头',403);
    // Same-origin check for compat writes: a supplied Origin must match this host (loopback
    // http or tunnel https); a missing Origin stays allowed for local non-browser clients.
    if(!trustedOrigin(req))throw new PocketError('请求来源不受信任',403);
    if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new PocketError('需要 JSON 请求',415);
    const v=await body(req);
    if(path==='/mobile/api/sessions')return json(res,200,await adapter.create(message(v.text),v.requestId,v.modelId));
    const m=path.match(/^\/mobile\/api\/sessions\/([^/]+)\/(messages|cancel)$/);
    if(m){const id=checkId(m[1]);return json(res,200,m[2]==='messages'?await adapter.send(id,message(v.text),v.requestId,v.modelId):await adapter.cancel(id));}
   }
   throw new PocketError('入口不存在或请求方法不支持',404);
  }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e instanceof PocketError?e.message:'服务暂时不可用，请稍后重试'});else res.end();}
 };
 handler.dispose=()=>hub.dispose();
 return handler;
}

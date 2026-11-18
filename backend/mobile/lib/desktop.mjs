import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readConnectJson, connectFrame, applyStepUpdate } from './stream.mjs';
const exec = promisify(execFile);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class PocketError extends Error { constructor(message,status=503){super(message);this.status=status;} }
export function checkId(id){if(!UUID.test(id))throw new PocketError('会话 ID 无效',400);return id;}
const running=s=>/RUNNING|PENDING|IN_PROGRESS|CANCELLING/.test(s||'');
export function state(s){return running(s)?'running':/ERROR|FAILED/.test(s||'')?'error':'idle';}
function textOf(v,depth=0){
 if(v==null||depth>9)return '';if(typeof v==='string')return v;if(Array.isArray(v))return v.map(x=>textOf(x,depth+1)).filter(Boolean).join('\n');if(typeof v!=='object')return '';
 for(const k of ['text','content','response','message','output','result','markdown','value','items','parts'])if(v[k]!=null){const t=textOf(v[k],depth+1);if(t)return t;}
 return '';
}
export function mapSteps(steps,offset=0){return steps.flatMap((s,i)=>{
 const type=String(s.type||'');let role='tool',value,toolName;
 if(type.includes('USER_INPUT')){role='user';value=s.userInput;}
 else if(type.includes('PLANNER_RESPONSE')){role='assistant';value=s.plannerResponse;}
 else if(type.includes('MODEL_RESPONSE')){role='assistant';value=s.modelResponse;}
 else{const keys=Object.keys(s).filter(k=>!['type','status','metadata','permissions','errorDetails','renderInfo','taskDetails'].includes(k));value=s[keys[0]];toolName=type.replace('CORTEX_STEP_TYPE_','').toLowerCase().replaceAll('_',' ');}
 const text=textOf(value);if(!text&&role==='assistant')return [];
 return [{id:String(offset+i),role,text:text||toolName||'执行步骤',status:state(s.status),...(toolName?{toolName,detail:JSON.stringify(value??{},null,2).slice(0,48000)}:{})}];
});}
function parseWorkspace(value){try{return JSON.parse(value||'[]').map(s=>decodeURI(s)).join(', ');}catch{return value||'';}}
export class DesktopAdapter {
 constructor(config={}){this.config=config;this.home=config.home||join(homedir(),'.gemini','antigravity');this.endpoint=null;this.discovery=null;this.checkedAt=0;this.requests=new Map();}
 async discover(force=false){
  if(!force&&this.endpoint&&Date.now()-this.checkedAt<15000)return this.endpoint;
  if(this.discovery)return this.discovery;
  this.discovery=(async()=>{
   if(process.platform!=='win32')throw new PocketError('当前自动发现支持 Windows 桌面端');
   const script='$p=Get-CimInstance Win32_Process | Where-Object {$_.Name -eq "language_server.exe"}; @($p | ForEach-Object {$q=$_; [PSCustomObject]@{pid=$q.ProcessId;exe=$q.ExecutablePath;cmd=$q.CommandLine;ports=@(Get-NetTCPConnection -State Listen -OwningProcess $q.ProcessId -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort)}}) | ConvertTo-Json -Compress';
   const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});
   const rows=[].concat(JSON.parse(stdout||'[]')||[]);
   const matches=[];
   for(const row of rows){
    if(!/[/\\]antigravity[/\\]/i.test(row.exe||'')||/antigravity-cli/.test(row.cmd||''))continue;
    const m=row.cmd.match(/--?csrf_token(?:=|\s+)(?:"([^"]+)"|([^\s]+))/);const token=m?.[1]||m?.[2];if(!token)continue;
    for(const port of row.ports||[]){try{
     const base='http://127.0.0.1:'+Number(port);const r=await fetch(base+'/healthz',{signal:AbortSignal.timeout(800)});if(!r.ok)continue;
     const endpoint={base,token,pid:row.pid,exe:row.exe};
     const test=await this.rpcAt(endpoint,'GetAllCascadeTrajectories',{});if(test&&typeof test==='object')matches.push(endpoint);
    }catch{}}
   }
   if(matches.length>1)throw new PocketError('发现多个桌面后台，请关闭多余实例后重试');
   if(!matches.length){this.endpoint=null;throw new PocketError('未连接桌面端，请先打开 Antigravity');}
   this.endpoint=matches[0];this.checkedAt=Date.now();return this.endpoint;
  })();
  try{return await this.discovery;}finally{this.discovery=null;}
 }
 async rpcAt(ep,method,body){
  const r=await fetch(ep.base+'/exa.language_server_pb.LanguageServerService/'+method,{method:'POST',headers:{'content-type':'application/json','x-codeium-csrf-token':ep.token},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new PocketError('桌面接口请求失败（'+r.status+'）',502);
  return await r.json();
 }
 async rpc(method,body){const ep=await this.discover();try{return await this.rpcAt(ep,method,body);}catch(e){this.checkedAt=0;throw e;}}
 async models(force=false){
  if(!force&&this.catalog&&Date.now()-this.catalogAt<60000)return this.catalog;
  const [data,available]=await Promise.all([this.rpc('GetCascadeModelConfigData',{}),this.rpc('GetAvailableModels',{forceRefresh:false}).catch(()=>({}))]);
  const recommended=data.defaultOverrideModelConfig?.modelOrAlias?.model;
  const models=(data.clientModelConfigs||[]).filter(c=>c.modelOrAlias?.model&&c.label).map(c=>({id:c.modelOrAlias.model,label:c.label,modelId:c.modelId,disabled:!!c.disabled,description:c.tagDescription||c.tagTitle||'',recommended:c.modelOrAlias.model===recommended}));
  if(!models.length)throw new PocketError('桌面端暂未提供可用模型列表');
  this.modelNames=new Map(Object.entries(available.response?.models||{}).filter(([,v])=>v.model).map(([id,v])=>[v.model,v.label||id]));
  for(const m of models)this.modelNames.set(m.id,m.label);
  this.catalog={models,defaultModelId:models.find(m=>m.recommended&&!m.disabled)?.id||models.find(m=>!m.disabled)?.id};this.catalogAt=Date.now();return this.catalog;
 }
 async modelConfig(modelId){
  if(modelId==null||modelId==='')return undefined;
  if(typeof modelId!=='string'||modelId.length>150)throw new PocketError('模型选择无效',400);
  const {models}=await this.models();const model=models.find(m=>m.id===modelId);
  if(!model||model.disabled)throw new PocketError('该模型当前不可用，请刷新模型列表',400);
  return {plannerConfig:{planModel:model.id}};
 }
 modelInfo(config){const p=config?.plannerConfig;const id=p?.planModel;if(!id)return {};return {modelId:id,modelLabel:this.modelNames?.get(id)||p.modelName||id};}
 async watchSession(id,onSnapshot,signal){
  checkId(id);const initial=await this.session(id);
  const ep=await this.discover();const r=await fetch(ep.base+'/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates',{method:'POST',headers:{'content-type':'application/connect+json','connect-protocol-version':'1','x-codeium-csrf-token':ep.token},body:connectFrame({conversationId:id,subscriberId:randomUUID(),trajectoryVerbosity:2}),signal});
  if(!r.ok)throw new PocketError('桌面实时接口暂不可用（'+r.status+'）',502);
  onSnapshot(initial);let steps=new Map(),total=0,revision=0,session=initial.session,receivedSteps=false;
  for await(const value of readConnectJson(r.body)){
   if(signal.aborted)break;const u=value.update;if(!u)continue;
   const update=u.mainTrajectoryUpdate?.stepsUpdate;
   if(update){receivedSteps=true;const merged=applyStepUpdate(steps,update);steps=merged.steps;total=merged.total;}
   const config=u.executorMetadata?.cascadeConfig||u.mainTrajectoryUpdate?.metadata?.staticConfig?.cascadeConfig;
   session={...session,...(u.status!=null?{status:state(u.status)}:{}),...this.modelInfo(config)};
   const messages=receivedSteps?[...steps].sort(([a],[b])=>a-b).flatMap(([i,s])=>mapSteps([s],i)):initial.messages;
   onSnapshot({session,messages,revision:'stream:'+ ++revision,truncated:total>500});
  }
 }
 async status(){try{await this.discover();return {connected:true,backend:'desktop',message:'已连接 Antigravity 桌面会话',capabilities:{list:true,read:true,send:true,cancel:true,create:true}};}catch(e){return {connected:false,backend:'desktop',message:e.message,capabilities:{list:true,read:false,send:false,cancel:false,create:false}};}}
 async summaries(){
  const file=join(this.home,'conversation_summaries.db');await stat(file).catch(()=>{throw new PocketError('尚未找到桌面会话数据库');});
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file,{readOnly:true});
  try{const stored=new Set((await readdir(join(this.home,'conversations'))).filter(n=>n.endsWith('.db')).map(n=>n.slice(0,-3)));return db.prepare('SELECT conversation_id,title,preview,last_modified_time,status,workspace_uris,project_id,step_count,not_fully_idle,parent_conversation_id,killed FROM conversation_summaries ORDER BY last_modified_time DESC').all().filter(r=>stored.has(r.conversation_id)&&!r.killed&&!r.parent_conversation_id).slice(0,300).map(r=>({id:r.conversation_id,title:r.title||r.preview?.slice(0,60)||'未命名会话',updatedAt:r.last_modified_time,status:r.not_fully_idle?'running':state(r.status),workspace:parseWorkspace(r.workspace_uris),projectId:r.project_id,stepCount:r.step_count}));}finally{db.close();}
 }
 async sessions(){return {sessions:await this.summaries()};}
 async session(id){
  checkId(id);const all=await this.summaries();const summary=all.find(s=>s.id===id);if(!summary)throw new PocketError('桌面会话不存在或已隐藏',404);
  const v=await this.rpc('GetCascadeTrajectory',{cascadeId:id,trajectoryVerbosity:2});
  const t=v.trajectory||{};const total=Number(v.numTotalSteps)||t.steps?.length||0;let steps=t.steps||[];let offset=0;
  // The desktop RPC pages long trajectories. Fetch the tail explicitly when needed.
  if(total>steps.length){offset=Math.max(0,total-500);const page=await this.rpc('GetCascadeTrajectorySteps',{cascadeId:id,trajectoryVerbosity:2,stepOffset:offset});if(page.steps)steps=page.steps;}
  const config=t.executorMetadatas?.at(-1)?.cascadeConfig||t.executorMetadata?.cascadeConfig||t.metadata?.staticConfig?.cascadeConfig;
  return {session:{...summary,status:state(v.status),...this.modelInfo(config)},messages:mapSteps(steps,offset),revision:String(total)+':'+JSON.stringify(steps).length,truncated:offset>0};
 }
 async cli(args,projectId){const ep=await this.discover();const env={...process.env,ANTIGRAVITY_LS_ADDRESS:ep.base.replace('http://',''),ANTIGRAVITY_CSRF_TOKEN:ep.token};if(projectId)env.ANTIGRAVITY_PROJECT_ID=projectId;
  try{const {stdout}=await exec(ep.exe,['agentapi',...args],{env,windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});return stdout.trim()?JSON.parse(stdout):{};}catch(e){throw new PocketError(e.killed?'桌面发送超时，请刷新会话确认是否已收到，勿直接重复发送':'桌面端拒绝了本次请求，请检查桌面状态',502);}
 }
 async once(requestId,action){if(typeof requestId!=='string'||!UUID.test(requestId))throw new PocketError('缺少有效请求标识',400);const old=this.requests.get(requestId);if(old)return old;const p=Promise.resolve().then(action);this.requests.set(requestId,p);while(this.requests.size>500)this.requests.delete(this.requests.keys().next().value);return p;}
 async send(id,text,requestId,modelId){checkId(id);return this.once(requestId,async()=>{const config=await this.modelConfig(modelId);const view=await this.session(id);if(view.session.status==='running')throw new PocketError('会话正在执行，请等待完成或先停止',409);await this.rpc('SendUserCascadeMessage',{cascadeId:id,items:[{text}],...(config?{cascadeConfig:config}:{})});return {accepted:true};});}
 async create(text,requestId,modelId){return this.once(requestId,async()=>{const catalog=await this.models();const config=await this.modelConfig(modelId||catalog.defaultModelId);const id=randomUUID();await this.rpc('StartCascade',{cascadeId:id,trajectoryType:'CORTEX_TRAJECTORY_TYPE_CASCADE',source:'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT'});try{await this.rpc('SendUserCascadeMessage',{cascadeId:id,items:[{text}],cascadeConfig:config});}catch(e){throw new PocketError('会话已创建，但消息提交未确认，请刷新列表检查后重试（'+id+'）',502);}return {id};});}
 async cancel(id){checkId(id);await this.session(id);await this.rpc('CancelCascadeInvocation',{cascadeId:id});return {accepted:true};}
}

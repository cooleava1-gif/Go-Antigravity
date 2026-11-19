import { createMessageRenderer } from './messages.js';
import { createEventStream } from './events.js';
const API_BASE = '/goagy-pocket/api';
const POLL_MS = 1500;
const BACKGROUND_MS = 10000;
const ui = Object.fromEntries(['sessionDrawer','drawerBackdrop','openDrawer','closeDrawer','newSession','refreshSessions','sessionList','backendLabel','sidebarDot','mainContent','conversationEyebrow','conversationTitle','connectionStatus','connectionLabel','refreshConversation','notice','noticeText','reconnect','authLink','conversation','emptyState','emptyTitle','emptyDescription','emptyAction','messages','activityDot','activityLabel','cancelGeneration','composer','messageInput','draftStatus','sendMessage','announcement','sessionSearch','themeSelect','modelPicker','modelPickerLabel','modelContext','modelSheet','modelSearch','modelOptions','modelCatalogStatus','closeModelSheet','sheetBackdrop','copySheet','copyText','closeCopySheet','selectCopyText','scrollToBottom','scrollLabel','quickSessions','quickNew','transportLabel'].map(id => [id, document.getElementById(id)]));
const state = { connection:'connecting', capabilities:{}, version:'', statusMessage:'', sessions:[], selectedId:null, creating:false, session:null, messages:[], loadingList:false, loadingSession:false, sending:false, cancelling:false, unauthorized:false, notice:'', actionError:'', listError:'', sessionError:'', lastStatus:0, lastList:0, signature:null, drawer:false, draftAvailable:true, polling:false, pendingRefresh:false, selectionVersion:0, models:[], modelId:'', defaultModelId:'', modelError:'', modelsLoading:false, sheet:null, transport:'connecting' };
const mobile = matchMedia('(max-width: 760px)');
const busyStates = new Set(['running','streaming','generating','working','busy','pending','in_progress','queued','executing']);
const labels = {running:'执行中',streaming:'生成中',generating:'生成中',working:'执行中',busy:'执行中',pending:'等待中',in_progress:'执行中',queued:'排队中',executing:'执行中',idle:'可继续',completed:'已完成',complete:'已完成',done:'已完成',error:'出错',failed:'失败',cancelled:'已停止',canceled:'已停止',stopped:'已停止',ready:'就绪'};
let lastFocus, sheetFocus, events;
function plain(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') { try { return JSON.stringify(value,null,2); } catch { return String(value); } }
  return String(value);
}
function make(tag, className, text) { const el = document.createElement(tag); if(className) el.className = className; if(text != null) el.textContent = plain(text); return el; }
function icon(name) {
  const el = document.createElementNS('http://www.w3.org/2000/svg','svg'); el.classList.add('icon'); el.setAttribute('aria-hidden','true');
  const use = document.createElementNS('http://www.w3.org/2000/svg','use'); use.setAttribute('href','#i-'+name); el.append(use); return el;
}
const statusLabel = value => labels[plain(value).toLowerCase()] || plain(value) || '可继续';
const busy = () => state.session?.status ? busyStates.has(plain(state.session.status).toLowerCase()) : busyStates.has(plain(state.messages.at(-1)?.status).toLowerCase());
const can = capability => !state.unauthorized && state.connection === 'connected' && state.capabilities[capability] === true;
const draftKey = (id = state.selectedId) => 'goagy-pocket:draft:' + (id == null ? 'new' : encodeURIComponent(id));
function saveDraft(id = state.selectedId, text = ui.messageInput.value) {
  try { if(text) sessionStorage.setItem(draftKey(id),text); else sessionStorage.removeItem(draftKey(id)); } catch { state.draftAvailable = false; }
}
function resizeInput() { ui.messageInput.style.height = 'auto'; ui.messageInput.style.height = Math.min(180, Math.max(60,ui.messageInput.scrollHeight))+'px'; }
function restoreDraft() { let value = ''; try { value = sessionStorage.getItem(draftKey()) || ''; } catch { state.draftAvailable = false; } ui.messageInput.value = value; resizeInput(); }
function rememberSession() { try { if(state.selectedId) sessionStorage.setItem('goagy-pocket:selected',state.selectedId); else if(state.creating) sessionStorage.setItem('goagy-pocket:selected',':new'); else sessionStorage.removeItem('goagy-pocket:selected'); } catch { /* optional storage */ } }
function announce(text) { ui.announcement.textContent = text; }
class ApiError extends Error { constructor(message,status=0) { super(message); this.name='ApiError'; this.status=status; } }
async function api(path,body) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(),15000); const post = body !== undefined;
  try {
    const response = await fetch(API_BASE+path,{method:post?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:post?{'Content-Type':'application/json','X-Goagy-Pocket':'1'}:{Accept:'application/json'},...(post?{body:JSON.stringify(body)}:{}),signal:controller.signal});
    if(response.status === 401) throw new ApiError('身份验证已失效，请返回 Pocket 首页重新验证。',401);
    if(response.status === 204 && post) return {};
    let data = null;
    if((response.headers.get('content-type') || '').includes('json')) { try { data = await response.json(); } catch { throw new ApiError('服务返回了无法解析的 JSON。',response.status); } }
    if(!response.ok) throw new ApiError(typeof data?.message === 'string'?data.message:typeof data?.error === 'string'?data.error:'请求失败（HTTP '+response.status+'）。',response.status);
    if(!data || typeof data !== 'object') throw new ApiError('服务未返回 JSON 数据，请检查 Pocket 服务。',response.status);
    return data;
  } catch(error) {
    if(error instanceof ApiError) throw error;
    if(post) throw new ApiError('请求'+(error.name==='AbortError'?'超时':'中断')+'，是否已提交尚未确认。请刷新会话检查后再决定是否重试。');
    throw new ApiError(error.name==='AbortError'?'连接超时，请检查桌面是否在线。':'无法连接 Pocket 服务，请检查网络与桌面连接。');
  } finally { clearTimeout(timer); }
}
function handleAuth(error) { if(error.status!==401) return false; state.unauthorized=true; events?.stop(); state.connection='offline'; state.notice=error.message; render(); return true; }
function relativeTime(value) {
  const time = new Date(value).getTime(); if(!Number.isFinite(time)) return '最近'; const age = Date.now()-time;
  if(age<60000) return '刚刚'; if(age<3600000) return Math.floor(age/60000)+' 分钟前'; if(age<86400000) return Math.floor(age/3600000)+' 小时前'; if(age<604800000) return Math.floor(age/86400000)+' 天前';
  return new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric'}).format(time);
}
function placeholder(text,action,callback) {
  const node=make('div','session-list-empty',text); if(action) { const button=make('button','',action); button.type='button'; button.addEventListener('click',callback); node.append(button); } ui.sessionList.replaceChildren(node);
}
const sessionNodes = new Map();
function renderSessions() {
  ui.sessionList.setAttribute('aria-busy',String(state.loadingList));
  const query=ui.sessionSearch.value.trim().toLocaleLowerCase(),sessions=state.sessions.filter(s=>[s.title,s.workspace].some(value=>plain(value).toLocaleLowerCase().includes(query)));
  if(!state.sessions.length||!sessions.length){sessionNodes.clear();
    if(query)placeholder('没有找到匹配的会话。');
    else if(state.loadingList)placeholder('正在读取桌面会话…');
    else if(state.unauthorized)placeholder('验证身份后即可读取桌面会话。');
    else if(state.connection!=='connected')placeholder('桌面尚未连接，最近会话将在连接后显示。','重新连接',reconnect);
    else if(!can('list'))placeholder('当前桌面未提供会话列表能力。');
    else if(state.listError)placeholder('会话列表读取失败。','重新读取',reconnect);
    else placeholder('还没有会话。从一个新想法开始吧。',can('create')?'新建会话':'刷新列表',can('create')?beginNewSession:reconnect);
    return;
  }
  if(ui.sessionList.querySelector('.session-list-empty'))ui.sessionList.replaceChildren();
  const wanted=new Set();
  sessions.forEach((session,index)=>{wanted.add(session.id);let record=sessionNodes.get(session.id);
    if(!record){const button=make('button','session-item');button.type='button';button.append(icon('chat'));const copy=make('span','session-item-copy'),title=make('span','session-item-title'),meta=make('span','session-item-meta');copy.append(title,meta);button.append(copy);button.addEventListener('click',()=>selectSession(session.id));record={button,title,meta};sessionNodes.set(session.id,record);}
    const {button,title,meta}=record;button.disabled=state.sending;button.setAttribute('aria-current',String(state.selectedId===session.id));button.setAttribute('aria-label',(session.title||'未命名会话')+'，'+statusLabel(session.status));button.title=plain(session.title||'未命名会话');title.textContent=plain(session.title||'未命名会话');meta.textContent=statusLabel(session.status)+' · '+relativeTime(session.updatedAt);const at=ui.sessionList.children[index];if(at!==button)ui.sessionList.insertBefore(button,at||null);
  });
  for(const [id,record] of sessionNodes)if(!wanted.has(id)){record.button.remove();sessionNodes.delete(id);}
}
const messageRenderer = createMessageRenderer({container:ui.messages,scroller:ui.conversation,jump:ui.scrollToBottom,label:ui.scrollLabel,statusLabel,icon,copy:copyText});
function renderMessages() { messageRenderer.update(state.messages,state.selectedId); }
function emptyCopy() {
  if(state.unauthorized) return ['验证身份后继续','当前登录状态已失效，请返回 Pocket 首页完成身份验证。','返回 Pocket 首页','auth'];
  if(state.connection==='connecting') return ['正在连接你的桌面','界面已就绪，正在确认桌面连接和可用能力。','重新连接桌面','reconnect'];
  if(state.connection!=='connected') return ['等待桌面连接',state.statusMessage||'暂时无法连接桌面。可以重新连接，已输入的草稿会保留。','重新连接桌面','reconnect'];
  if(state.loadingSession) return ['正在读取会话','正在从桌面获取消息，请稍候。','刷新当前会话','refresh'];
  if(state.sessionError) return ['会话暂时无法读取','消息读取失败。你可以刷新重试，草稿仍会保留。','重新读取会话','refresh'];
  if(state.creating) return ['从一个新想法开始','在下方写下第一条消息，发送后会在桌面创建新会话。','开始输入','focus'];
  if(state.selectedId&&!can('read')) return ['当前桌面不支持读取消息','会话已保留，等待桌面提供读取能力后即可继续。','重新检查连接','reconnect'];
  if(state.selectedId) return ['会话已准备好',can('send')?'这里还没有消息。在下方写下你的第一条消息。':'这里还没有消息，当前桌面尚未提供发送能力。',can('send')?'开始输入':'刷新当前会话',can('send')?'focus':'refresh'];
  if(state.sessions.length) return ['工作流，随身继续。','打开会话列表，选择想要继续的工作。','选择会话','sessions'];
  return ['工作流，随身继续。',can('create')?'从新的想法开始。写下第一条消息，在桌面开启会话。':'暂时没有可读取的会话，可以在桌面创建会话后刷新。',can('create')?'新建会话':'刷新会话列表',can('create')?'new':'refresh'];
}
function render() {
  const connected=state.connection==='connected'&&!state.unauthorized, connectionText=state.unauthorized?'待验证':connected?'桌面在线':state.connection==='connecting'?'连接中':'桌面离线';
  ui.connectionLabel.textContent=connectionText; ui.connectionStatus.className='connection-status '+(connected?'connected':state.connection==='connecting'?'':'offline'); ui.connectionStatus.querySelector('.status-dot').className='status-dot '+(connected?'connected':state.connection==='connecting'?'':'offline'); ui.sidebarDot.className='status-dot '+(connected?'connected':'offline'); ui.backendLabel.textContent=connected?'已连接 Antigravity'+(state.version?' · '+state.version:''):connectionText;
  const current=state.sessions.find(s=>s.id===state.selectedId); ui.conversationTitle.textContent=state.creating?'新建会话':state.session?.title||current?.title||'Goagy Pocket'; ui.conversationEyebrow.textContent=state.selectedId?plain(current?.workspace||'桌面会话 · 随时继续'):state.creating?'新的想法，即刻开始':'你的随身工作区';
  const notice=state.unauthorized?state.notice:state.notice||state.actionError||state.sessionError||state.listError; ui.notice.hidden=!notice; ui.noticeText.textContent=notice; ui.authLink.hidden=!state.unauthorized; ui.reconnect.hidden=state.unauthorized; ui.reconnect.disabled=state.sending;
  const showMessages=Boolean(state.selectedId&&state.messages.length); ui.emptyState.hidden=showMessages; ui.messages.hidden=!showMessages; ui.conversation.setAttribute('aria-busy',String(state.loadingSession));
  if(!showMessages) { const [title,description,action,key]=emptyCopy(); ui.emptyTitle.textContent=title; ui.emptyDescription.textContent=description; ui.emptyAction.replaceChildren(icon(key==='new'?'plus':key==='focus'?'send':key==='sessions'?'chat':'refresh'),make('span','',action)); ui.emptyAction.dataset.action=key; ui.emptyAction.disabled=state.loadingSession||state.sending; }
  renderMessages(); const running=busy(); let activity='桌面已就绪';
  if(state.unauthorized) activity='请先验证身份'; else if(!connected) activity=state.connection==='connecting'?'正在确认桌面连接…':'连接中断 · 可继续编辑草稿'; else if(state.sending) activity=state.creating?'正在创建会话…':'正在提交消息…'; else if(state.cancelling) activity='正在请求停止…'; else if(running) activity='Antigravity 正在执行'; else if(state.creating) activity='发送第一条消息以创建会话'; else if(!state.selectedId) activity='选择会话，或开始新会话'; else if(!can('send')) activity='当前桌面未开放发送能力';
  ui.activityLabel.textContent=activity; ui.activityDot.className='status-dot '+(connected?running||state.sending?'busy':'connected':'offline'); ui.cancelGeneration.hidden=!(can('cancel')&&state.selectedId&&running); ui.cancelGeneration.disabled=state.sending||state.cancelling;
  ui.quickNew.disabled=ui.newSession.disabled=!can('create')||state.sending; ui.newSession.title=can('create')?'创建新的桌面会话':'当前桌面尚未提供新建会话能力';
  const mayCompose=state.creating?can('create'):Boolean(state.selectedId&&can('send')&&can('read')&&!state.loadingSession&&!state.sessionError); ui.messageInput.disabled=state.sending; ui.messageInput.placeholder=state.creating?'写下第一条消息，开启新的会话…':connected?'发送消息，继续你的工作…':'可以先写下想法，连接桌面后再发送…'; ui.sendMessage.disabled=!mayCompose||state.sending||state.cancelling||running||!ui.messageInput.value.trim(); ui.sendMessage.setAttribute('aria-label',state.sending?'正在提交消息':state.creating?'创建会话并发送消息':'发送消息');
  ui.refreshSessions.disabled=state.loadingList||state.sending; ui.refreshConversation.disabled=state.loadingSession||state.sending; ui.draftStatus.textContent=state.draftAvailable?'草稿已保留':'草稿仅保留在此页'; renderModelControl();
}
async function loadStatus() {
  try { const data=await api('/status'); if(typeof data.connected!=='boolean'||!data.capabilities||typeof data.capabilities!=='object') throw new ApiError('桌面状态数据格式不正确。'); state.connection=data.connected?'connected':'offline'; state.capabilities=data.capabilities; state.version=plain(data.version); state.statusMessage=plain(data.message); state.notice=data.connected?'':state.statusMessage||'桌面当前离线。请确认 Antigravity 已启动并重新连接。'; return data.connected; }
  catch(error) { if(!handleAuth(error)) {state.connection='offline';state.notice=error.message;state.statusMessage=error.message;} return false; }
  finally {state.lastStatus=Date.now();render();}
}
async function loadSessions() {
  if(!can('list')||state.loadingList) return; state.loadingList=true; renderSessions(); render();
  try {
    const data=await api('/sessions'); if(!Array.isArray(data.sessions)) throw new ApiError('会话列表数据格式不正确。'); state.sessions=data.sessions.filter(s=>s&&s.id!=null).map(s=>({...s,id:plain(s.id)})); state.listError=''; state.lastList=Date.now();
    let remembered; try {remembered=sessionStorage.getItem('goagy-pocket:selected');} catch { /* optional storage */ }
    if(!state.selectedId&&!state.creating&&remembered===':new'&&can('create')) {state.creating=true;restoreDraft();}
    else if(!state.selectedId&&!state.creating&&state.sessions.length&&can('read')) await selectSession((state.sessions.find(s=>s.id===remembered)||state.sessions[0]).id,false);
  } catch(error) {if(!handleAuth(error)) state.listError=error.message;}
  finally {state.loadingList=false;renderSessions();render();}
}
async function loadSession(id=state.selectedId,initial=false) {
  if(!id||!can('read')) return; const version=state.selectionVersion; if(initial){state.loadingSession=true;render();}
  try {
    const data=await api('/sessions/'+encodeURIComponent(id)); if(!data.session||!Array.isArray(data.messages)) throw new ApiError('会话消息数据格式不正确。'); if(state.selectedId!==id||version!==state.selectionVersion) return;
    state.session=data.session; state.messages=data.messages.filter(m=>m&&typeof m==='object'); state.sessionError=''; const item=state.sessions.find(s=>s.id===id); if(item){item.title=data.session.title||item.title;item.status=data.session.status||item.status;}
  } catch(error) {if(!handleAuth(error)&&state.selectedId===id&&version===state.selectionVersion) state.sessionError=error.message;}
  finally {if(state.selectedId===id&&version===state.selectionVersion){state.loadingSession=false;render();}}
}
async function selectSession(id,close=true) {
  if(state.sending) return; if(id===state.selectedId&&!state.sessionError){if(close)setDrawer(false);return;}
  saveDraft();state.selectionVersion++;state.selectedId=id;state.creating=false;state.session=null;state.messages=[];state.signature=null;state.sessionError='';state.actionError='';restoreDraft();restoreModel();rememberSession();if(close)setDrawer(false);renderSessions();render();events?.connect(id,true);await loadSession(id,true);
}
function beginNewSession() {
  if(!can('create')||state.sending)return;saveDraft();state.selectionVersion++;state.selectedId=null;state.creating=true;state.session=null;state.messages=[];state.signature=null;state.sessionError='';state.actionError='';restoreDraft();restoreModel();rememberSession();setDrawer(false);renderSessions();render();events?.connect(null,true);ui.messageInput.focus();
}
function createRequestId() {
  if(typeof globalThis.crypto?.randomUUID==='function')return crypto.randomUUID();
  if(typeof globalThis.crypto?.getRandomValues!=='function')throw new Error('安全随机数不可用');
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
}
async function submitMessage(event) {
  event?.preventDefault();const text=ui.messageInput.value.trim(),creating=state.creating,id=state.selectedId;
  if(!text||state.sending||state.cancelling||busy()||!(creating?can('create'):id&&can('send')&&can('read')))return;
  let requestId;try{requestId=createRequestId();}catch{state.actionError='当前浏览器无法生成安全请求 ID。请更换支持 Web Crypto 的浏览器。';render();return;}
  saveDraft(id,ui.messageInput.value);state.sending=true;state.actionError='';render();renderSessions();
  try {
    const result=await api(creating?'/sessions':'/sessions/'+encodeURIComponent(id)+'/messages',{text,requestId,...(state.modelId?{modelId:state.modelId}:{})});
    if(creating&&(typeof result.id!=='string'||!result.id))throw new ApiError('服务器未返回新会话 ID。请刷新列表确认创建结果后再重试。');
    if(!creating&&result.accepted!==true)throw new ApiError('服务器未确认接收消息。请刷新会话确认后再重试。');
    saveDraft(id,'');ui.messageInput.value='';resizeInput();
    if(creating){state.selectedId=result.id;state.creating=false;state.selectionVersion++;state.session={id:result.id,title:'新会话',status:'pending'};state.messages=[];state.signature=null;rememberSession();saveModel();events?.connect(state.selectedId,true);}
    announce(creating?'会话已创建，正在同步消息。':'消息已提交，正在同步桌面回复。');await loadSession(state.selectedId);state.lastList=0;
  } catch(error) {if(!handleAuth(error))state.actionError=error.message+' 输入已保留，不会自动重发。';announce('发送未确认，输入已保留。');}
  finally {state.sending=false;render();renderSessions();if(!ui.messageInput.disabled)ui.messageInput.focus();if(state.pendingRefresh){state.pendingRefresh=false;reconnect();}}
}
async function cancelGeneration() {
  if(!can('cancel')||!state.selectedId||!busy()||state.cancelling||state.sending)return;const id=state.selectedId;state.cancelling=true;state.actionError='';render();
  try {await api('/sessions/'+encodeURIComponent(id)+'/cancel',{});announce('停止请求已提交。');await loadSession(id);}catch(error){if(!handleAuth(error))state.actionError=error.message+' 不会自动重试停止请求。';}finally{state.cancelling=false;render();}
}
function saveModel(){try{sessionStorage.setItem(draftKey()+':model',state.modelId);}catch{}}
function restoreModel(){try{state.modelId=sessionStorage.getItem(draftKey()+':model')||'';}catch{state.modelId='';}if(state.models.length&&!state.models.some(m=>m.id===state.modelId))state.modelId='';}
async function loadModels(){
  if(state.modelsLoading||state.unauthorized)return;state.modelsLoading=true;state.modelError='';renderModelOptions();
  try{const data=await api('/models');if(!Array.isArray(data.models))throw new ApiError('模型目录格式不正确。');const seen=new Set();state.models=data.models.filter(m=>m&&typeof m.id==='string'&&m.id&&typeof m.label==='string'&&m.disabled!==true&&!seen.has(m.id)&&seen.add(m.id)).map(m=>({id:m.id,label:m.label,description:plain(m.description),recommended:m.recommended===true}));state.defaultModelId=plain(data.defaultModelId);if(state.modelId&&!state.models.some(m=>m.id===state.modelId)){state.modelId='';saveModel();}}
  catch(error){if(!handleAuth(error))state.modelError=error.message;state.models=[];state.modelId='';}
  finally{state.modelsLoading=false;renderModelControl();renderModelOptions();}
}
function renderModelControl(){
  const model=state.models.find(m=>m.id===state.modelId),label=model?.label||'自动';ui.modelPickerLabel.textContent=label;ui.modelPicker.setAttribute('aria-label','选择下次发送模型：'+label);ui.modelPicker.disabled=busy()||state.sending||state.cancelling||state.unauthorized;
  const current=plain(state.session?.modelLabel||state.session?.modelId);ui.modelContext.textContent=(current?'当前：'+current+' · ':'')+(model?'下次：'+label:state.selectedId?'下次沿用会话配置':'新会话使用推荐模型');ui.modelContext.title=ui.modelContext.textContent;if(ui.modelPicker.disabled&&state.sheet==='model')setSheet(null);
}
function renderModelOptions(){
  if(state.sheet!=='model')return;const query=ui.modelSearch.value.trim().toLocaleLowerCase(),fragment=document.createDocumentFragment();
  const add=(id,label,description,recommended=false)=>{const button=make('button','model-option');button.type='button';button.setAttribute('aria-pressed',String(state.modelId===id));button.disabled=busy()||state.sending||state.cancelling;const title=make('span','model-option-title',label);if(recommended)title.append(make('span','recommended','推荐'));button.append(title,make('span','model-option-description',description));button.addEventListener('click',()=>{if(button.disabled)return;state.modelId=id;saveModel();renderModelControl();setSheet(null);announce('下次发送将'+(id?'使用 '+label:'使用会话默认配置'));});fragment.append(button);};
  add('','自动','已有会话沿用其配置，新会话使用目录推荐模型；不读取桌面尚未发送的模型选择');const matches=state.models.filter(m=>(m.label+' '+m.id+' '+m.description).toLocaleLowerCase().includes(query));for(const model of matches)add(model.id,model.label,model.description||model.id,model.recommended);
  if(state.modelError){const retry=make('button','catalog-retry','重新读取模型目录');retry.type='button';retry.addEventListener('click',loadModels);fragment.append(retry);}ui.modelOptions.replaceChildren(fragment);ui.modelCatalogStatus.textContent=state.modelsLoading?'正在读取桌面模型目录…':state.modelError?'模型目录暂不可用，已有会话可使用自动配置。':query&&!matches.length?'没有匹配模型，可更换关键词。':state.models.length+' 个可用模型 · 仅在发送时提交';
}
function syncModal(){ui.mainContent.inert=state.drawer||!!state.sheet;ui.sessionDrawer.inert=!!state.sheet||(mobile.matches&&!state.drawer);}
function setSheet(kind,returnFocus=true){const was=state.sheet;if(kind&&!was)sheetFocus=document.activeElement;state.sheet=kind;ui.modelSheet.hidden=kind!=='model';ui.copySheet.hidden=kind!=='copy';ui.sheetBackdrop.hidden=!kind;ui.modelPicker.setAttribute('aria-expanded',String(kind==='model'));syncModal();if(kind==='model'){ui.modelSearch.value='';renderModelOptions();ui.modelSearch.focus();}else if(kind==='copy'){ui.copyText.focus();ui.copyText.select();}else if(was&&returnFocus&&sheetFocus?.isConnected)sheetFocus.focus({preventScroll:true});}
async function copyText(value,button){
  const previous=document.activeElement;let copied=false;try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(plain(value));copied=true;}}catch{}
  if(!copied){const area=make('textarea','clipboard-buffer');area.value=plain(value);area.setAttribute('aria-label','复制缓冲区');area.readOnly=true;document.body.append(area);area.select();try{copied=document.execCommand('copy');}catch{}area.remove();if(previous?.isConnected)previous.focus({preventScroll:true});}if(copied){button.dataset.copied='true';announce('已复制到剪贴板');setTimeout(()=>{delete button.dataset.copied;},1800);}else{ui.copyText.value=plain(value);setSheet('copy');}
}
function setDrawer(open,returnFocus=true){const was=state.drawer;state.drawer=open&&mobile.matches&&!state.sheet;if(state.drawer&&!was)lastFocus=document.activeElement;ui.sessionDrawer.classList.toggle('is-open',state.drawer);ui.drawerBackdrop.hidden=!state.drawer;ui.openDrawer.setAttribute('aria-expanded',String(state.drawer));ui.quickSessions.setAttribute('aria-expanded',String(state.drawer));syncModal();if(state.drawer){ui.sessionDrawer.setAttribute('role','dialog');ui.sessionDrawer.setAttribute('aria-modal','true');ui.closeDrawer.focus();}else{ui.sessionDrawer.removeAttribute('role');ui.sessionDrawer.removeAttribute('aria-modal');if(was&&returnFocus&&mobile.matches&&lastFocus?.isConnected)lastFocus.focus({preventScroll:true});}}
function applyStatus(data){if(typeof data?.connected!=='boolean'||!data.capabilities||typeof data.capabilities!=='object')throw new ApiError('桌面状态数据格式不正确。');state.connection=data.connected?'connected':'offline';state.capabilities=data.capabilities;state.version=plain(data.version);state.statusMessage=plain(data.message);state.notice=data.connected?'':state.statusMessage||'桌面当前离线。请确认 Antigravity 已启动。';state.lastStatus=Date.now();render();renderSessions();}
function applySessions(data){if(!Array.isArray(data?.sessions))return;state.sessions=data.sessions.filter(s=>s&&s.id!=null).map(s=>({...s,id:plain(s.id)}));state.listError='';state.lastList=Date.now();renderSessions();render();if(!state.selectedId&&!state.creating&&state.sessions.length&&can('read')){let remembered;try{remembered=sessionStorage.getItem('goagy-pocket:selected');}catch{}if(remembered!==':new')void selectSession((state.sessions.find(s=>s.id===remembered)||state.sessions[0]).id,false);}}
function applySnapshot(data,id){if(!id||state.selectedId!==id||!data?.session||!Array.isArray(data.messages)||plain(data.session.id)!==id)return;state.session=data.session;state.messages=data.messages.filter(m=>m&&typeof m==='object');state.sessionError='';state.loadingSession=false;const item=state.sessions.find(s=>s.id===id);if(item){item.title=data.session.title||item.title;item.status=data.session.status||item.status;}render();renderSessions();}
async function refresh(force=false){if(state.polling){state.pendingRefresh ||= force;return;}if(state.unauthorized&&!force)return;state.polling=true;try{if(force){state.unauthorized=false;state.notice='';state.actionError='';state.lastStatus=0;}if(force||!state.lastStatus||Date.now()-state.lastStatus>=10000||state.connection!=='connected')await loadStatus();if(can('list')&&(force||!state.lastList||Date.now()-state.lastList>=10000))await loadSessions();if(state.selectedId&&can('read')&&!state.loadingSession)await loadSession();renderSessions();render();}finally{state.polling=false;if(state.pendingRefresh&&!state.sending){state.pendingRefresh=false;void reconnect();}}}
async function reconnect(){if(state.sending){state.pendingRefresh=true;return;}await refresh(true);if(!state.unauthorized){void loadModels();events.connect(state.selectedId,true);}}
events=createEventStream({onStatus:applyStatus,onSessions:applySessions,onSnapshot:applySnapshot,onSyncError(data){if(data?.status===401){handleAuth(new ApiError('身份验证已失效，请返回 Pocket 首页重新验证。',401));return;}state.sessionError=plain(data?.error)||'实时同步暂时失败，请稍后重试。';render();},onMode(mode){state.transport=mode;ui.transportLabel.textContent=mode==='live'?'实时同步':mode==='polling'?'兼容同步':mode==='stopped'?'同步已暂停':'连接实时同步…';},probeAuth:loadStatus,poll:()=>refresh(),blocked:()=>state.unauthorized});
ui.composer.addEventListener('submit',submitMessage);ui.messageInput.addEventListener('input',()=>{saveDraft();resizeInput();render();messageRenderer.layout();});ui.messageInput.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&!event.isComposing){event.preventDefault();if(!ui.sendMessage.disabled)ui.composer.requestSubmit();}});
ui.newSession.addEventListener('click',beginNewSession);ui.quickNew.addEventListener('click',beginNewSession);ui.cancelGeneration.addEventListener('click',cancelGeneration);ui.refreshSessions.addEventListener('click',reconnect);ui.refreshConversation.addEventListener('click',reconnect);ui.reconnect.addEventListener('click',reconnect);
ui.emptyAction.addEventListener('click',()=>{const action=ui.emptyAction.dataset.action;if(action==='auth')location.assign('/pocket-login');else if(action==='new')beginNewSession();else if(action==='focus')ui.messageInput.focus();else if(action==='sessions'){if(mobile.matches)setDrawer(true);else ui.sessionSearch.focus();}else void reconnect();});
ui.openDrawer.addEventListener('click',()=>setDrawer(true));ui.quickSessions.addEventListener('click',()=>setDrawer(true));ui.closeDrawer.addEventListener('click',()=>setDrawer(false));ui.drawerBackdrop.addEventListener('click',()=>setDrawer(false));ui.sessionSearch.addEventListener('input',renderSessions);ui.modelPicker.addEventListener('click',()=>{if(!ui.modelPicker.disabled)setSheet('model');});ui.modelSearch.addEventListener('input',renderModelOptions);ui.closeModelSheet.addEventListener('click',()=>setSheet(null));ui.closeCopySheet.addEventListener('click',()=>setSheet(null));ui.sheetBackdrop.addEventListener('click',()=>setSheet(null));ui.selectCopyText.addEventListener('click',()=>{ui.copyText.focus();ui.copyText.select();});
document.addEventListener('keydown',event=>{const modal=state.sheet?(state.sheet==='model'?ui.modelSheet:ui.copySheet):state.drawer?ui.sessionDrawer:null;if(!modal)return;if(event.key==='Escape'){event.preventDefault();if(state.sheet)setSheet(null);else setDrawer(false);return;}if(event.key==='Tab'){const controls=[...modal.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]')].filter(node=>node.getClientRects().length&&node.tabIndex>=0);if(!controls.length){event.preventDefault();modal.focus();return;}if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1).focus();}else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0].focus();}}});
const darkQuery=matchMedia('(prefers-color-scheme: dark)');function applyTheme(){const setting=ui.themeSelect.value,dark=setting==='dark'||setting==='system'&&darkQuery.matches;document.documentElement.dataset.theme=dark?'dark':'light';document.querySelector('meta[name=theme-color]').content=dark?'#101a17':'#f5f7f4';}try{const theme=localStorage.getItem('goagy-pocket:theme');if(['system','light','dark'].includes(theme))ui.themeSelect.value=theme;}catch{}ui.themeSelect.addEventListener('change',()=>{try{localStorage.setItem('goagy-pocket:theme',ui.themeSelect.value);}catch{}applyTheme();});darkQuery.addEventListener('change',applyTheme);applyTheme();
function updateViewport(){const vv=window.visualViewport;if(mobile.matches&&vv&&vv.scale<1.05){document.documentElement.style.setProperty('--app-height',Math.round(vv.height)+'px');document.documentElement.style.setProperty('--viewport-top',Math.round(vv.offsetTop)+'px');document.documentElement.classList.toggle('keyboard-open',window.innerHeight-vv.height>120);}else{document.documentElement.style.removeProperty('--app-height');document.documentElement.style.removeProperty('--viewport-top');document.documentElement.classList.remove('keyboard-open');}messageRenderer.layout();}window.visualViewport?.addEventListener('resize',updateViewport);window.visualViewport?.addEventListener('scroll',updateViewport);window.addEventListener('resize',updateViewport);mobile.addEventListener('change',()=>{setDrawer(false,false);updateViewport();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!state.unauthorized&&!events.active)events.retry();});window.addEventListener('online',()=>{if(!state.unauthorized)void reconnect();});window.addEventListener('offline',()=>{events.stop();state.connection='offline';state.notice='网络已断开。恢复网络后可重新连接，消息不会自动重发。';render();});window.addEventListener('pagehide',()=>{saveDraft();events.stop();});window.addEventListener('pageshow',event=>{if(event.persisted&&!state.unauthorized)void reconnect();});
try{const selected=sessionStorage.getItem('goagy-pocket:selected');if(selected&&selected!==':new')state.selectedId=selected;else if(selected===':new')state.creating=true;}catch{}restoreDraft();restoreModel();setDrawer(false,false);renderSessions();render();updateViewport();void reconnect();

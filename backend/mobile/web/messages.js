// All message content enters through text nodes; HTML is never interpreted.
const NL = String.fromCharCode(10);
const TICK = String.fromCharCode(96);
const FENCE = TICK.repeat(3);
function text(value) { if (value == null) return ''; if (typeof value === 'object') { try { return JSON.stringify(value, null, 2); } catch {} } return String(value); }
function node(tag, className, value) { const el = document.createElement(tag); if (className) el.className = className; if (value != null) el.textContent = text(value); return el; }
function setText(el, value) {
  const next = text(value), previous = el.textContent || '';
  if (previous === next) return;
  if (el.childNodes.length === 1 && el.firstChild.nodeType === 3 && next.startsWith(previous)) el.firstChild.appendData(next.slice(previous.length));
  else if (el.childNodes.length === 1 && el.firstChild.nodeType === 3) el.firstChild.replaceData(0, el.firstChild.length, next);
  else el.textContent = next;
}
function inlineTokens(value) {
  const tokens=[];let cursor=0;
  while(cursor<value.length){
    const marks=['**',TICK].map(mark=>({mark,start:value.indexOf(mark,cursor)})).filter(item=>item.start>=0).sort((a,b)=>a.start-b.start);
    const item=marks[0];if(!item){tokens.push({tag:'text',value:value.slice(cursor)});break;}
    const end=value.indexOf(item.mark,item.start+item.mark.length);if(end<0){tokens.push({tag:'text',value:value.slice(cursor)});break;}
    if(item.start>cursor)tokens.push({tag:'text',value:value.slice(cursor,item.start)});tokens.push({tag:item.mark===TICK?'code':'strong',value:value.slice(item.start+item.mark.length,end)});cursor=end+item.mark.length;
  }
  return tokens.length?tokens:[{tag:'text',value}];
}
function updateInline(container, value) {
  const tokens = inlineTokens(value);
  tokens.forEach((token,index) => {
    let el = container.childNodes[index]; const tag = token.tag === 'text' ? '#text' : token.tag.toUpperCase();
    if (!el || el.nodeName !== tag) {
      const replacement = token.tag === 'text' ? document.createTextNode('') : node(token.tag);
      if (el) el.replaceWith(replacement); else container.append(replacement); el = replacement;
    }
    if (token.tag === 'text') { if (el.data !== token.value) { if (token.value.startsWith(el.data)) el.appendData(token.value.slice(el.data.length)); else el.replaceData(0,el.length,token.value); } }
    else setText(el,token.value);
  });
  while(container.childNodes.length > tokens.length) container.lastChild.remove();
}
function blocks(value) {
  const lines = text(value).split(NL), output = []; let prose = [], code = null;
  const flush = () => { if (prose.length) { output.push({type:'text',value:prose.join(NL)}); prose=[]; } };
  for (const line of lines) {
    if (line.trimStart().startsWith(FENCE)) { if (code) { output.push(code); code=null; } else { flush(); code={type:'code',label:line.trim().slice(3).trim().slice(0,60),value:''}; } continue; }
    if (code) { code.value += (code.hasLine ? NL : '') + line; code.hasLine=true; } else prose.push(line);
  }
  if (code) output.push(code); flush(); return output.length ? output : [{type:'text',value:'（暂无内容）'}];
}
export function createMessageRenderer({container,scroller,jump,label,statusLabel,icon,copy}) {
  const records = new Map(); let sessionId, following = true, unseen = false, scheduled = 0;
  const nearBottom = () => scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight < 80;
  const selected = () => { const selection=getSelection(); return selection && !selection.isCollapsed && container.contains(selection.anchorNode); };
  function updateJump() { jump.hidden = following; label.textContent = unseen ? '新消息 · 回到底部' : '回到底部'; }
  function goBottom() { following=true;unseen=false;cancelAnimationFrame(scheduled);scheduled=requestAnimationFrame(()=>{if(following&&!selected())scroller.scrollTop=scroller.scrollHeight;updateJump();}); }
  scroller.addEventListener('scroll',()=>{following=nearBottom();if(following)unseen=false;updateJump();},{passive:true});
  for(const type of ['wheel','touchstart','pointerdown'])scroller.addEventListener(type,()=>cancelAnimationFrame(scheduled),{passive:true});
  jump.addEventListener('click',goBottom);
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(()=>{if(following&&!selected())goBottom();}) : null; resize?.observe(scroller);
  function copyButton(getValue, name) { const button=node('button','copy-button');button.type='button';button.setAttribute('aria-label',name);button.title=name;button.append(icon('copy'));button.addEventListener('click',()=>copy(getValue(),button));return button; }
  function content(record,value) {
    const parts=blocks(value);
    parts.forEach((part,index)=>{
      let block=record.blocks[index];
      if(!block||block.type!==part.type){
        const root=node(part.type==='code'?'div':'p',part.type==='code'?'code-block':'');block={type:part.type,root};
        if(part.type==='code'){const bar=node('div','code-toolbar');block.label=node('span','code-label');block.code=node('code');block.pre=node('pre');block.pre.append(block.code);bar.append(block.label,copyButton(()=>block.code.textContent,'复制代码'));root.append(bar,block.pre);}
        const old=record.text.children[index];if(old)old.replaceWith(root);else record.text.append(root);record.blocks[index]=block;
      }
      if(part.type==='code'){setText(block.label,part.label||'代码');setText(block.code,part.value);}else updateInline(block.root,part.value);
    });
    while(record.text.children.length>parts.length)record.text.lastElementChild.remove();record.blocks.length=parts.length;
  }
  function detailsCard(){const details=node('details','tool-card'),summary=node('summary'),title=node('span'),pre=node('pre');summary.append(icon('terminal'),title);details.append(summary,pre);return{root:details,title,pre};}
  function create(message,key){
    const role=['user','assistant','tool','system'].includes(message.role)?message.role:'system';
    const article=node('article','message '+role);article.dataset.messageId=key;article.setAttribute('role','listitem');
    const head=node('div','message-head'),avatar=node('span','message-avatar');avatar.setAttribute('aria-hidden','true');if(role==='assistant')avatar.append(icon('orbit'));else avatar.textContent=role==='user'?'你':role==='tool'?'›_':'·';
    const status=node('span','message-status'),body=node('div','message-body'),contentRoot=node('div','message-text');head.append(avatar,node('span','message-role',role==='user'?'你':role==='assistant'?'Antigravity':role==='tool'?'工具调用':'系统'),status);
    const record={article,role,status,body,text:contentRoot,blocks:[],message};head.append(copyButton(()=>[text(record.message.text),text(record.message.detail)].filter(Boolean).join(NL+NL),'复制消息'));
    if(role==='tool'){record.tool=detailsCard();body.append(record.tool.root);}else body.append(contentRoot);article.append(head,body);return record;
  }
  function update(messages,id){
    const changedSession=id!==sessionId;
    if(changedSession){for(const record of records.values())record.article.remove();records.clear();sessionId=id;following=true;unseen=false;}
    const shouldFollow=following&&!selected(); const anchor=!shouldFollow?[...container.children].find(el=>el.getBoundingClientRect().bottom>scroller.getBoundingClientRect().top):null;const anchorY=anchor?.getBoundingClientRect().top;
    const keys=new Set();let changed=false;
    messages.forEach((message,index)=>{
      const base=text(message.id || 'position:'+index+':'+text(message.role)); let key=base;let duplicate=1;while(keys.has(key))key=base+':'+duplicate++;keys.add(key);
      let record=records.get(key);const role=['user','assistant','tool','system'].includes(message.role)?message.role:'system';
      if(record&&record.role!==role){record.article.remove();records.delete(key);record=null;}
      if(!record){record=create(message,key);records.set(key,record);changed=true;}
      const signature=JSON.stringify([message.text,message.detail,message.toolName,message.status]);
      if(record.signature!==signature){changed=true;record.message=message;setText(record.status,message.status?statusLabel(message.status):'');
        if(record.tool){setText(record.tool.title,message.toolName||'工具执行详情');setText(record.tool.pre,[text(message.text),text(message.detail)].filter(Boolean).join(NL+NL)||'暂无工具输出');}
        else{content(record,message.text);if(message.detail){if(!record.detail){record.detail=detailsCard();setText(record.detail.title,'查看详情');record.body.append(record.detail.root);}setText(record.detail.pre,message.detail);}else if(record.detail){record.detail.root.remove();record.detail=null;}}record.signature=signature;
      }
      const at=container.children[index];if(at!==record.article)container.insertBefore(record.article,at||null);
    });
    for(const [key,record] of records)if(!keys.has(key)){record.article.remove();records.delete(key);changed=true;}
    if(changed){if(shouldFollow)goBottom();else{if(anchor?.isConnected)scroller.scrollTop+=anchor.getBoundingClientRect().top-anchorY;unseen=true;updateJump();}}
  }
  return {update,goBottom,layout(){if(following&&!selected())goBottom();}};
}

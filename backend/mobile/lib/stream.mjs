// Connect server-streaming envelopes: one flag byte, four-byte network length, JSON payload.
export async function* readConnectJson(body){
 let pending=Buffer.alloc(0);
 for await(const chunk of body){
  pending=Buffer.concat([pending,chunk]);
  while(pending.length>=5){
   const flags=pending[0],length=pending.readUInt32BE(1);
   if(length>32*1024*1024)throw Error('桌面流消息过大');
   if(pending.length<length+5)break;
   if(flags&1)throw Error('不支持压缩的桌面流');
   const value=JSON.parse(pending.subarray(5,length+5).toString('utf8'));pending=pending.subarray(length+5);
   if(flags&2){if(value.error)throw Error('桌面输出流中断');return;}
   yield value;
  }
 }
 if(pending.length)throw Error('桌面输出流不完整');
}
export function connectFrame(value){const json=Buffer.from(JSON.stringify(value));const frame=Buffer.alloc(json.length+5);frame.writeUInt32BE(json.length,1);json.copy(frame,5);return frame;}
// Indices are absolute even when the server returns a paged tail.
export function applyStepUpdate(previous,update){
 const total=Number(update.totalLength)||0,start=Math.max(0,total-500),steps=new Map([...previous].filter(([i])=>i>=start&&i<total));
 for(let i=0;i<(update.indices?.length||0);i++){const index=update.indices[i];if(Number.isInteger(index)&&index>=start&&index<total&&update.steps?.[i])steps.set(index,update.steps[i]);}
 return {steps,total};
}

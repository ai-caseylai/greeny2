
import {DurableObject} from 'cloudflare:workers';
import {DEVICE_ID_RE,hkTime,json} from './stamplc-protocol';
import {sensorField,sensorFacts,sensorAnswer,sampleNotice} from './sensor-answer';
interface AgentEnv {DEVICE_HUB:DurableObjectNamespace;AI:Ai;AI_MODEL?:string;}
export function cleanAnswer(text:string):string {return text.split(/\r?\n\s*(?:使用者問題|用户问题|User(?:\s+question)?|Human)\s*[:：]/i,1)[0].trim();}
export class GreenyAgent extends DurableObject<AgentEnv> {
  async fetch(request:Request):Promise<Response>{
    if(new URL(request.url).pathname!=='/api/chat'||request.method!=='POST')return json({error:'Not found'},404);
    let body:any;try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}
    if(typeof body.message!=='string'||!body.message.trim()||body.message.length>4000||typeof body.device_id!=='string'||!DEVICE_ID_RE.test(body.device_id))return json({error:'Valid message and device_id required'},400);
    const id=body.device_id,stub=this.env.DEVICE_HUB.get(this.env.DEVICE_HUB.idFromName(id));
    const response=await stub.fetch('https://device-hub/do-telemetry?device_id='+encodeURIComponent(id));
    if(!response.ok)return json({error:'Sensor data unavailable'},503);
    const data=await response.json<any>(),now=Date.now();
    const facts=sensorFacts(data,id,now),utc=facts.utc_ms;
    const field=sensorField(body.message);
    if(field)return json({reply:sensorAnswer(field,facts),read_only:true,ai_used:false,answer_source:'validated_sensor',data_meta:facts});
    if(data.status!=='ok'||utc===null)return json({reply:'目前未收到此裝置有效的感測器數據；不能提供即時 pH、EC 或溫度。',read_only:true,ai_used:false,data_meta:facts});
    if(!this.env.AI)return json({error:'AI service unavailable',read_only:true,data_meta:facts},503);
    const systemPrompt='你是 Greeny2 水耕感測器的只讀助手。請用繁體中文直接回答，不要輸出編輯過程或重複段落。只根據下方已取得的資料回答，絕不補造數值、採樣時間或設備狀態。TDS=null 代表未量測，不可當作零或自行以 EC 換算。EC=0 只代表讀數為零，不足以斷言探頭故障。日期時間全部為香港時間，請列出實際採樣時間；過期或離線資料須明確稱為最後收到的資料，不能稱為即時。此服務沒有控制或校正工具，沒有開關任何繼電器，不能宣稱已執行操作。若使用者要求操作，請指示使用有權限的手動 Relay 控制頁。已回讀的繼電器是驅動 GPIO 狀態，並非機械接點或負載回授。\n目前香港時間：'+hkTime(now)+'\n權威感測資料 JSON：'+JSON.stringify(facts);
    const messages=[{role:'system',content:systemPrompt},{role:'user',content:body.message}];
    try{
      const output:any=await this.env.AI.run(this.env.AI_MODEL||'@cf/meta/llama-3.1-8b-instruct-fp8-fast',{messages,max_tokens:256,temperature:0.1,repetition_penalty:1.1});
      const reply=typeof output?.response==='string'?output.response:typeof output?.choices?.[0]?.message?.content==='string'?output.choices[0].message.content:'';
      const answer=cleanAnswer(reply);
      if(!answer)return json({error:'AI returned no readable answer',read_only:true,data_meta:facts},502);
      return json({reply:(!facts.fresh?sampleNotice(facts)+'\n':'採樣時間：'+facts.date_time_hk+'（香港）。\n')+answer,read_only:true,ai_used:true,data_meta:facts});
    }catch{return json({error:'AI inference unavailable',read_only:true,data_meta:facts},502);}
  }
}

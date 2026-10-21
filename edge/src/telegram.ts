import {DurableObject} from 'cloudflare:workers';
import {smallJSON,json} from './access';
import {DEVICE_ID_RE} from './stamplc-protocol';
import {sensorField,sensorFacts,sensorAnswer} from './sensor-answer';
interface TelegramEnv {DB:D1Database;DEVICE_HUB:DurableObjectNamespace;TELEGRAM_HUB:DurableObjectNamespace;TELEGRAM_BOT_TOKEN?:string;TELEGRAM_WEBHOOK_SECRET?:string;}
const HEX=/^[0-9a-f]{64}$/;
const BOT=/^(?=.{5,32}$)[A-Za-z][A-Za-z0-9_]*bot$/i;
export function secureEqual(a:string,b:string):boolean{if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
export async function sha256(value:string):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');}
export function phoneDigits(value:unknown):string|null {if(typeof value!=='string')return null;const digits=value.replace(/[+\s()-]/g,'');return /^[1-9][0-9]{7,14}$/.test(digits)?digits:null;}
export function privateMessage(update:any,now=Date.now()):any|null{
  const m=update?.message;
  if(!Number.isSafeInteger(update?.update_id)||update.update_id<0||!m||m.chat?.type!=='private'||!Number.isSafeInteger(m.chat.id)||m.chat.id<1||!Number.isSafeInteger(m.from?.id)||m.from.id!==m.chat.id||m.from.is_bot===true||!Number.isSafeInteger(m.message_id)||m.message_id<1||!Number.isSafeInteger(m.date)||m.date*1000>now+5000||now-m.date*1000>120000)return null;
  return m;
}
export function telegramField(text:unknown,username:string):ReturnType<typeof sensorField>{
  if(typeof text!=='string'||text.length>128)return null;
  const slash=text.trim().match(/^\/(ec|temp|ph)(?:@([A-Za-z0-9_]+))?$/i);
  if(slash)return slash[2]&&slash[2].toLowerCase()!==username.toLowerCase()?null:slash[1].toLowerCase() as 'ec'|'temp'|'ph';
  return sensorField(text);
}
const KEYS={keyboard:[[{text:'ec?'},{text:'temp?'},{text:'ph?'}]],resize_keyboard:true,is_persistent:true};
const HELP='Greeny2 水質查詢：輸入 ec?、temp?、ph?，或按下方按鈕。EC 單位 µS/cm，溫度 °C。離線／過期資料會標示最後採樣時間。';
export async function telegramWebhook(request:Request,env:TelegramEnv):Promise<Response>{
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  const expected=env.TELEGRAM_WEBHOOK_SECRET||'',supplied=request.headers.get('X-Telegram-Bot-Api-Secret-Token')||'';
  if(!HEX.test(expected)||!secureEqual(expected,supplied))return json({error:'Unauthorized'},401);
  let update:any;try{update=await smallJSON(request,32768);}catch{return json({error:'Invalid update'},400);}
  if(!privateMessage(update))return json({ok:true});
  if(!env.TELEGRAM_HUB)return json({error:'Telegram service unavailable'},503);
  return env.TELEGRAM_HUB.get(env.TELEGRAM_HUB.idFromName('greeny2-telegram')).fetch(new Request('https://telegram/webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(update)}));
}
export class TelegramHub extends DurableObject<TelegramEnv>{
  private tail:Promise<void>=Promise.resolve();
  async fetch(request:Request):Promise<Response>{
    const previous=this.tail;let release!:()=>void;this.tail=new Promise<void>(resolve=>{release=resolve;});
    await previous;try{return await this.route(request);}finally{release();}
  }
  private async route(request:Request):Promise<Response>{
    const url=new URL(request.url);
    if(url.pathname==='/config'&&request.method==='GET')return json(await this.status());
    if(url.pathname==='/config'&&request.method==='PUT')return this.configure(request);
    if(url.pathname==='/webhook'&&request.method==='POST'){
      let update:any;try{update=await smallJSON(request,32768);}catch{return json({error:'Invalid update'},400);}
      return this.handle(update);
    }
    return json({error:'Not found'},404);
  }
  private async status():Promise<any>{
    const c:any=await this.ctx.storage.get('config'),binding:any=await this.ctx.storage.get('binding'),stats:any=await this.ctx.storage.get('stats'),pending:any=await this.ctx.storage.get('pending'),diag:any=await this.ctx.storage.get('pairing_diag');
    return {configured:!!c,enabled:c?.enabled===true,bot_username:c?.bot_username??null,device_id:c?.device_id??null,paired:!!binding,account_mask:c?.account_mask??null,pairing_expires_ms:binding?null:c?.pair_expires_ms??null,pairing_stage:binding?'paired':pending?.expires_ms>Date.now()?'awaiting_contact':'awaiting_start',last_pairing_event:diag??null,last_query:stats?.last_query??null,last_send:stats?.last_send??null,submitted_queries:stats?.submitted_queries??{},delivery_mode:'webhook_response',read_only:true};
  }
  private async configure(request:Request):Promise<Response>{
    let c:any;try{c=await smallJSON(request,4096);}catch{return json({error:'Invalid configuration'},400);}
    if(!c||typeof c!=='object'||Array.isArray(c)||typeof c.enabled!=='boolean'||typeof c.device_id!=='string'||!DEVICE_ID_RE.test(c.device_id)||typeof c.bot_username!=='string'||!BOT.test(c.bot_username)||!Number.isSafeInteger(c?.bot_id)||c.bot_id<1||typeof c.phone_hash!=='string'||!HEX.test(c.phone_hash)||typeof c.pair_hash!=='string'||!HEX.test(c.pair_hash)||!/^\*\*\*[0-9]{4}$/.test(c?.account_mask||'')||!Number.isSafeInteger(c?.pair_expires_ms)||c.pair_expires_ms<=Date.now()||c.pair_expires_ms>Date.now()+3600000||('reset_pair' in c&&typeof c.reset_pair!=='boolean'))return json({error:'Valid private Telegram configuration required'},400);
    if(!(await this.env.DB.prepare('SELECT id FROM devices WHERE id=?').bind(c.device_id).first()))return json({error:'Unregistered device'},400);
    const old:any=await this.ctx.storage.get('config');
    if(c.reset_pair===true||old&&(old.bot_id!==c.bot_id||old.phone_hash!==c.phone_hash||old.device_id!==c.device_id)){
      await this.ctx.storage.delete(['binding','pending','stats','pairing_diag']);
    }
    await this.ctx.storage.put('config',{enabled:c.enabled,device_id:c.device_id,bot_username:c.bot_username,bot_id:c.bot_id,phone_hash:c.phone_hash,account_mask:c.account_mask,pair_hash:c.pair_hash,pair_expires_ms:c.pair_expires_ms});
    await this.ctx.storage.setAlarm(Date.now()+86400000);
    return json(await this.status());
  }
  private async handle(update:any):Promise<Response>{
    const m=privateMessage(update),c:any=await this.ctx.storage.get('config');
    if(!m||!c||c.enabled!==true)return json({ok:true});
    const key='update:'+update.update_id;
    if(await this.ctx.storage.get(key))return json({ok:true});
    const binding:any=await this.ctx.storage.get('binding');
    const text=typeof m.text==='string'?m.text.trim():'';
    const start=text.match(/^\/start(?:@([A-Za-z0-9_]+))?(?:\s+([A-Za-z0-9_-]{1,64}))?$/i);
    const targetOK=!start?.[1]||start[1].toLowerCase()===c.bot_username.toLowerCase();
    const own=binding?.user_id===m.from.id&&binding?.chat_id===m.chat.id;
    const diag:any={at_ms:Date.now(),kind:start?'start':m.contact?'contact':'other',reason:'ignored'};
    let reply:string|null=null,keyboard:any=KEYS,field:ReturnType<typeof sensorField>=null,available=false;
    if(own){
      field=telegramField(text,c.bot_username);
      if(field){
        try{
          const response=await this.env.DEVICE_HUB.get(this.env.DEVICE_HUB.idFromName(c.device_id)).fetch('https://device-hub/do-telemetry?device_id='+encodeURIComponent(c.device_id));
          if(!response.ok)throw new Error('Sensor unavailable');
          const facts=sensorFacts(await response.json<any>(),c.device_id);reply=sensorAnswer(field,facts);available=facts.utc_ms!==null&&facts[field]!==null;
        }catch{reply='Greeny2 暫時未能讀取感測資料，請稍後再輸入 ec?、temp? 或 ph?。';}
      }else if(start&&targetOK||/^\/help(?:@[A-Za-z0-9_]+)?$/i.test(text)||text&&!text.startsWith('/'))reply=HELP;
    }else if(!binding&&start&&targetOK){
      // Phone ownership is verified from Telegram's own contact, even when a client drops the deep-link payload.
      diag.reason='awaiting_contact';
      await this.ctx.storage.put('pending',{user_id:m.from.id,chat_id:m.chat.id,expires_ms:Date.now()+900000});
      reply='請按「確認手機號碼」，分享你自己的 Telegram 聯絡資料，以連結已授權的客戶手機。';
      keyboard={keyboard:[[{text:'確認手機號碼',request_contact:true}]],resize_keyboard:true,one_time_keyboard:true};
    }else if(!binding&&m.contact){
      const pending:any=await this.ctx.storage.get('pending'),digits=phoneDigits(m.contact.phone_number);
      if(pending?.user_id===m.from.id&&pending?.chat_id===m.chat.id&&pending.expires_ms>Date.now()&&m.contact.user_id===m.from.id&&digits){
        if(secureEqual(await sha256(digits),c.phone_hash)){
          await this.ctx.storage.put('binding',{user_id:m.from.id,chat_id:m.chat.id,paired_ms:Date.now()});
          await this.ctx.storage.put('config',{...c,pair_hash:null,pair_expires_ms:0});await this.ctx.storage.delete('pending');
          diag.reason='paired';reply='Greeny2 已連結你的 Telegram 手機。\n'+HELP;
        }else{diag.reason='wrong_phone';reply='手機號碼與已授權的客戶帳戶不符，尚未連結。';}
      }
    }
    if(reply===null){if(!binding)await this.ctx.storage.put('pairing_diag',diag);return json({ok:true});}
    // Persist before returning a Bot API method in the webhook response. Telegram does not return a delivery result for this mode.
    await this.ctx.storage.put(key,{phase:'handling',at:Date.now()});
    const outcome='webhook_submitted';
    await this.ctx.storage.put(key,{phase:outcome,at:Date.now()});
    if(!binding)await this.ctx.storage.put('pairing_diag',{...diag,send_status:outcome,delivery_mode:'webhook_response'});
    if(field){const stats:any=await this.ctx.storage.get('stats')||{};await this.ctx.storage.put('stats',{last_query:{field,at_ms:Date.now()},last_send:{status:outcome,at_ms:Date.now(),answer_available:available},submitted_queries:{...stats.submitted_queries,...(available?{[field]:Date.now()}:{})}});}
    return json({method:'sendMessage',chat_id:m.chat.id,text:reply,reply_markup:keyboard,protect_content:true});
  }
  async alarm():Promise<void>{
    const rows=await this.ctx.storage.list<any>({prefix:'update:',limit:1000}),expired:string[]=[];
    for(const [key,value] of rows)if(value.at<Date.now()-2*86400000)expired.push(key);
    if(expired.length)await this.ctx.storage.delete(expired);
    const pending:any=await this.ctx.storage.get('pending');if(pending&&pending.expires_ms<=Date.now())await this.ctx.storage.delete('pending');
    const c:any=await this.ctx.storage.get('config');if(c?.enabled)await this.ctx.storage.setAlarm(Date.now()+86400000);
  }
}

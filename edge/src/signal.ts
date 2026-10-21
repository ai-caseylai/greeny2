import {setting,smallJSON} from './access';
import {DEVICE_ID_RE,json} from './stamplc-protocol';
import {sensorField,sensorFacts,sensorAnswer} from './sensor-answer';
interface SignalEnv {DB:D1Database;DEVICE_HUB:DurableObjectNamespace;}
const CONFIG='signal_bridge_config';
const E164=/^\+[1-9][0-9]{7,14}$/;
async function digest(value:string):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');}
function same(a:string,b:string):boolean{if(a.length!==b.length)return false;let result=0;for(let i=0;i<a.length;i++)result|=a.charCodeAt(i)^b.charCodeAt(i);return result===0;}
async function config(env:SignalEnv):Promise<any>{try{return JSON.parse(await setting(env,CONFIG)||'null');}catch{return null;}}
export async function signalStatus(env:SignalEnv):Promise<Response>{const c=await config(env);return json({configured:!!c?.key_hash,enabled:c?.enabled===true,mode:c?.mode??null,device_id:c?.device_id??null,account_mask:c?.account_number?'***'+c.account_number.slice(-4):null});}
export async function configureSignal(request:Request,env:SignalEnv):Promise<Response>{
  let body:any;try{body=await smallJSON(request,2048);}catch{return json({error:'Invalid configuration'},400);}
  if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'Invalid configuration'},400);
  if(typeof body.enabled!=='boolean'||body.mode!=='note_to_self'||typeof body.account_number!=='string'||!E164.test(body.account_number)||typeof body.device_id!=='string'||!DEVICE_ID_RE.test(body.device_id)||typeof body.bridge_key!=='string'||!/^[0-9a-f]{64}$/.test(body.bridge_key))return json({error:'Valid Note to Self configuration required'},400);
  if(!(await env.DB.prepare('SELECT id FROM devices WHERE id=?').bind(body.device_id).first()))return json({error:'Unregistered device'},400);
  const value={enabled:body.enabled,mode:body.mode,account_number:body.account_number,device_id:body.device_id,key_hash:await digest(body.bridge_key)};
  await env.DB.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,unixepoch()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(CONFIG,JSON.stringify(value)).run();
  return signalStatus(env);
}
export async function signalQuery(request:Request,env:SignalEnv):Promise<Response>{
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  const c=await config(env),key=request.headers.get('X-Greeny-Signal-Key')||'';
  if(!c||c.enabled!==true||c.mode!=='note_to_self'||!E164.test(c.account_number||'')||!DEVICE_ID_RE.test(c.device_id||'')||!/^[0-9a-f]{64}$/.test(key)||!same(await digest(key),c.key_hash||''))return json({error:'Unauthorized Signal bridge'},401);
  let body:any;try{body=await smallJSON(request,2048);}catch{return json({error:'Invalid query'},400);}
  if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'Invalid query'},400);
  if(body.kind!=='note_to_self'||body.source_number!==c.account_number||('device_id' in body&&body.device_id!==c.device_id))return json({error:'Forbidden Signal query'},403);
  const field=sensorField(body.message);
  if(!field)return json({error:'Supported queries: ec?, temp?, ph?'},400);
  if(!Number.isSafeInteger(body.timestamp)||body.timestamp>Date.now()+5000||Date.now()-body.timestamp>120000)return json({error:'Query expired; send a new query'},400);
  const stub=env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(c.device_id));
  try{
    const response=await stub.fetch('https://device-hub/do-telemetry?device_id='+encodeURIComponent(c.device_id));
    if(!response.ok)return json({error:'Sensor service temporarily unavailable'},503);
    const facts=sensorFacts(await response.json<any>(),c.device_id);
    return json({reply:sensorAnswer(field,facts),field,value:facts[field],unit:field==='ec'?'µS/cm':field==='temp'?'°C':'pH',fresh:facts.fresh,connected:facts.connected,sample_time_hk:facts.date_time_hk,read_only:true,answer_source:'validated_sensor'});
  }catch{return json({error:'Sensor service temporarily unavailable'},503);}
}

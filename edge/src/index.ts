
import {DeviceHub} from './device-hub';
import {GreenyAgent} from './agent';
import {signJWT,verifyPassword} from './auth';
import {setting,currentUser,bearer,ownsDevice,deviceScope,isReadOnlyRequest,smallJSON,json} from './access';
import {DEVICE_ID_RE,relayRequest,type User} from './stamplc-protocol';
import {managementAPI} from './pages-adapter';
import {signalQuery,signalStatus,configureSignal} from './signal';
import {TelegramHub,telegramWebhook} from './telegram';
export interface Env {DB:D1Database;DEVICE_HUB:DurableObjectNamespace<DeviceHub>;GREENY_AGENT:DurableObjectNamespace<GreenyAgent>;AI:Ai;AI_MODEL?:string;ASSETS?:Fetcher;TELEGRAM_HUB:DurableObjectNamespace<TelegramHub>;TELEGRAM_BOT_TOKEN?:string;TELEGRAM_WEBHOOK_SECRET?:string;WORKBUDDY_API_URL?:string;WORKBUDDY_API_KEY?:string;WB_API_KEY?:string;}
function hub(env:Env,id:string){return env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(id));}
async function login(request:Request,env:Env){
  let body:any;try{body=await smallJSON(request);}catch{return json({error:'Invalid JSON'},400);}
  if(typeof body.username!=='string'||typeof body.password!=='string'||!body.username||!body.password)return json({error:'Username and password required'},400);
  const secret=await setting(env,'jwt_secret');if(secret.length<32)return json({error:'Server has not been initialized'},503);
  const row=await env.DB.prepare('SELECT id,username,password_hash,role,office_id,display_name FROM users WHERE username=? AND active=1').bind(body.username).first<any>();
  if(!row||!(await verifyPassword(body.password,row.password_hash)))return json({error:'Invalid credentials'},401);
  const user={id:row.id,username:row.username,role:row.role,office_id:row.office_id??null,display_name:row.display_name};
  const token=await signJWT({sub:row.id,...user,iat:Math.floor(Date.now()/1000)},secret);
  return json({token,user});
}
async function devices(env:Env,user:User){
  const scope=deviceScope(user,'d.id');const rows=await env.DB.prepare('SELECT d.* FROM devices d WHERE '+scope.clause+' ORDER BY d.id').bind(...scope.params).all<any>();
  const out=await Promise.all(rows.results.map(async row=>{try{const response=await hub(env,row.id).fetch('https://device-hub/state?device_id='+encodeURIComponent(row.id));const live=await response.json<any>();return {...row,...live,id:row.id,device_id:row.id,name:row.name,status:live.connected?'online':'offline'};}catch{return {...row,device_id:row.id,status:'unknown',connected:false,relay_valid:false};}}));
  return json({devices:out});
}
async function telemetry(url:URL,env:Env,user:User){
  const id=url.searchParams.get('device_id');if(id&&!(await ownsDevice(env,user,id)))return json({error:'Forbidden'},403);
  const scope=deviceScope(user,'t.device_id'),limit=Math.max(1,Math.min(1000,Number(url.searchParams.get('limit'))||100));
  const params:any[]=[...scope.params];let where=scope.clause;if(id){where+=' AND t.device_id=?';params.push(id);}params.push(limit);
  const result=await env.DB.prepare('SELECT t.*,t.water_temp AS temp,t.received_ms AS received_ms FROM telemetry t WHERE '+where+' ORDER BY COALESCE(t.utc_ms,t.ts_ms,t.created_at*1000) DESC,t.id DESC LIMIT ?').bind(...params).all<any>();
  return json({telemetry:result.results.map(row=>{let relays=null;try{relays=row.relays_json?JSON.parse(row.relays_json):null;}catch{}return {...row,relays,reported_relays:relays,relay_valid:row.relay_valid===1};})});
}
async function alerts(url:URL,env:Env,user:User){
  const id=url.searchParams.get('device_id');if(id&&!(await ownsDevice(env,user,id)))return json({error:'Forbidden'},403);
  const scope=deviceScope(user,'a.device_id'),params:any[]=[...scope.params];let where=scope.clause;
  if(id){where+=' AND a.device_id=?';params.push(id);}if(['0','1'].includes(url.searchParams.get('acknowledged')||'')){where+=' AND a.acknowledged=?';params.push(Number(url.searchParams.get('acknowledged')));}
  params.push(Math.max(1,Math.min(500,Number(url.searchParams.get('limit'))||50)));
  const result=await env.DB.prepare('SELECT a.* FROM alerts a WHERE '+where+' ORDER BY a.created_at DESC,a.id DESC LIMIT ?').bind(...params).all();return json({alerts:result.results});
}
async function thresholds(request:Request,env:Env,user:User){
  const map:Record<string,string>={phMin:'ph_min',phMax:'ph_max',ecMax:'ec_max',tempMin:'temp_min',tempMax:'temp_max'};
  const rows=await env.DB.prepare('SELECT key,value FROM settings WHERE key IN (?,?,?,?,?)').bind(...Object.values(map)).all<{key:string;value:string}>();
  const result:any={phMin:5.5,phMax:8.5,ecMax:2000,tempMin:18,tempMax:30};for(const [name,key] of Object.entries(map)){const value=rows.results.find(row=>row.key===key)?.value;if(value!==undefined&&Number.isFinite(Number(value)))result[name]=Number(value);}
  if(request.method==='GET')return json({thresholds:result});if(request.method!=='PUT')return json({error:'Method not allowed'},405);if(user.role!=='superadmin')return json({error:'Superadmin required'},403);
  const body=await smallJSON(request);const updates:any[]=[];
  for(const [name,key] of Object.entries(map)){const value=body[name]??body[key];if(value===undefined)continue;if(typeof value!=='number'||!Number.isFinite(value))return json({error:'Invalid threshold'},400);result[name]=value;updates.push(env.DB.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,unixepoch()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,String(value)));}
  if(result.phMin<0||result.phMax>14||result.phMin>=result.phMax||result.ecMax<0||result.tempMin>=result.tempMax)return json({error:'Invalid threshold range'},400);
  if(updates.length)await env.DB.batch(updates);return json({ok:true,thresholds:result,note:'Applied by device hubs within 60 seconds'});
}
export default {async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
  const url=new URL(request.url),path=url.pathname.replace(/\/+$/,'')||'/',method=request.method.toUpperCase();
  try{
    if(method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':url.origin,'Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'}});
    if((path.startsWith('/api/')||path.startsWith('/device/')||path.startsWith('/dashboard/')||path==='/health')&&(await setting(env,'greeny2_deployment_id'))!=='openezit:greeny2')return json({error:'Verified openezit database initialization required'},503);
    if(path==='/health'&&method==='GET'){
      const sampleColumns=await env.DB.prepare('PRAGMA table_info(telemetry)').all<any>();
      const commandColumns=await env.DB.prepare('PRAGMA table_info(relay_commands)').all<any>();
      const sampleNames=new Set(sampleColumns.results.map(row=>row.name)),commandNames=new Set(commandColumns.results.map(row=>row.name));
      const nullableTds=sampleColumns.results.some(row=>row.name==='tds'&&row.notnull===0);
      if(!nullableTds||!['ingest_id','utc_ms','date_time_hk','received_ms','relays_json','relay_valid','relay_session'].every(name=>sampleNames.has(name))||!['command_id','session_id','seq','channel','state','issued_ms','expires_ms','status','acked_utc_ms'].every(name=>commandNames.has(name)))return json({status:'error',error:'Own database schema is incomplete'},503);
      return json({status:'ok',service:'greeny2-openezit',protocol:2,schema_version:2,deployment_marker:'openezit:greeny2'});
    }
    if(path==='/api/telegram/webhook')return telegramWebhook(request,env);
    if(path==='/api/signal/query')return signalQuery(request,env);
    if(path==='/api/auth/login'&&method==='POST')return login(request,env);
    const upgrade=request.headers.get('Upgrade')?.toLowerCase()==='websocket';
    if(upgrade){
      const match=path.match(/^\/(device|dashboard)\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/);if(!match)return json({error:'Not found'},404);
      const [,kind,id]=match,token=url.searchParams.get('token')||'';const headers=new Headers(request.headers);headers.delete('X-Greeny-User-Id');headers.delete('X-Greeny-Role');
      if(kind==='device'){
        const expected=await setting(env,'device_token');if(expected.length<32||!token||token!==expected)return json({error:'Unauthorized device'},401);
        const registered=await env.DB.prepare('SELECT id FROM devices WHERE id=?').bind(id).first();if(!registered)return json({error:'Unregistered device'},403);
      }else{
        const user=await currentUser(token,env);if(!user)return json({error:'Unauthorized'},401);if(!(await ownsDevice(env,user,id)))return json({error:'Forbidden'},403);
        headers.set('X-Greeny-User-Id',String(user.sub));headers.set('X-Greeny-Role',user.role);
      }
      return hub(env,id).fetch(new Request(request,{headers}));
    }
    if(path.startsWith('/device/')||path.startsWith('/dashboard/'))return json({error:'WebSocket upgrade required'},426);
    if(!path.startsWith('/api/'))return env.ASSETS?env.ASSETS.fetch(request):json({error:'SPA asset binding unavailable'},503);
    const user=await currentUser(bearer(request),env);if(!user)return json({error:'Unauthorized'},401);
    if(user.role==='staff'&&!isReadOnlyRequest(method,path))return json({error:'Read-only account'},403);
    if(path==='/api/telegram/config'){
      if(user.role!=='superadmin')return json({error:'Superadmin required'},403);
      if(!['GET','PUT'].includes(method))return json({error:'Method not allowed'},405);
      return env.TELEGRAM_HUB.get(env.TELEGRAM_HUB.idFromName('greeny2-telegram')).fetch(new Request('https://telegram/config',{method,headers:{'Content-Type':'application/json'},...(method==='PUT'?{body:await request.text()}:{})}));
    }
    if(path==='/api/signal/config'){
      if(user.role!=='superadmin')return json({error:'Superadmin required'},403);
      if(method==='GET')return signalStatus(env);
      if(method==='PUT')return configureSignal(request,env);
      return json({error:'Method not allowed'},405);
    }
    if(path==='/api/auth/me'&&method==='GET')return json({user});
    if(path==='/api/devices'&&method==='GET')return devices(env,user);
    if(path==='/api/telemetry'&&method==='GET')return telemetry(url,env,user);
    if(path==='/api/telemetry')return json({error:'Telemetry ingestion uses the authenticated device WebSocket'},405);
    if(path==='/api/alerts'&&method==='GET')return alerts(url,env,user);
    if(path==='/api/alerts/ack'&&method==='POST'){
      const body=await smallJSON(request);if(!Number.isSafeInteger(body.alert_id))return json({error:'alert_id required'},400);
      const row=await env.DB.prepare('SELECT device_id FROM alerts WHERE id=?').bind(body.alert_id).first<{device_id:string}>();if(!row)return json({error:'Not found'},404);if(!(await ownsDevice(env,user,row.device_id)))return json({error:'Forbidden'},403);
      await env.DB.prepare('UPDATE alerts SET acknowledged=1 WHERE id=?').bind(body.alert_id).run();return json({success:true});
    }
    if(path==='/api/settings/thresholds')return thresholds(request,env,user);
    if(path==='/api/relay'){
      if(method==='GET'){
        const id=url.searchParams.get('device_id')||'esp32-sensor';if(!(await ownsDevice(env,user,id)))return json({error:'Forbidden'},403);return hub(env,id).fetch('https://device-hub/state?device_id='+encodeURIComponent(id));
      }
      if(method!=='POST')return json({error:'Method not allowed'},405);
      const command=relayRequest(await smallJSON(request));if(!command)return json({error:'UUID command_id,device_id,channel 1–4 and boolean state required'},400);if(!(await ownsDevice(env,user,command.device_id)))return json({error:'Forbidden'},403);
      return hub(env,command.device_id).fetch(new Request('https://device-hub/relay-cmd',{method:'POST',headers:{'Content-Type':'application/json','X-Greeny-User-Id':String(user.sub),'X-Greeny-Role':user.role},body:JSON.stringify(command)}));
    }
    if(path==='/api/chat'&&method==='POST'){
      const body=await smallJSON(request),id=body.device_id??'esp32-sensor';if(typeof body.message!=='string'||!body.message.trim()||body.message.length>4000||typeof id!=='string'||!DEVICE_ID_RE.test(id))return json({error:'Valid message and device_id required'},400);if(!(await ownsDevice(env,user,id)))return json({error:'Forbidden'},403);
      return env.GREENY_AGENT.get(env.GREENY_AGENT.idFromName('greeny-readonly')).fetch(new Request('https://greeny-agent/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:body.message,device_id:id})}));
    }
    const managed=await managementAPI(request,env,ctx,user);return managed??json({error:'Not found'},404);
  }catch(error){console.error('Greeny2 request failed',path,error instanceof Error?error.name:'error');return json({error:'Request could not be completed'},500);}
}};
export {DeviceHub,GreenyAgent,TelegramHub};

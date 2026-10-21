import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {createServer} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PRIVATE=path.join(ROOT,'.greeny2-telegram-private.json'),RUNTIME=path.join(ROOT,'.telegram-runtime');
const GENERATED=path.join(ROOT,'.greeny2-build/wrangler.openezit.generated.json');
const WRANGLER=path.join(ROOT,'edge/node_modules/wrangler/bin/wrangler.js');
const HOST='greeny2.openezit.com',BASE='https://'+HOST,ACCOUNT='3df8aa5f7718e535dfb690343b98e986',BOT='greeny2_bot',WEBHOOK=BASE+'/api/telegram/webhook';
const ensure=(ok,message)=>{if(!ok)throw new Error(message);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function validatePrivate(c){ensure(c?.base_url===BASE&&c.device_id==='esp32-sensor'&&c.bot_username===BOT&&/^\+[1-9][0-9]{7,14}$/.test(c.account_number||'')&&/^[0-9]{5,20}:[A-Za-z0-9_-]{20,100}$/.test(c.bot_token||'')&&/^[0-9a-f]{64}$/.test(c.webhook_secret||''),'Invalid private Telegram configuration. Preserve it; credentials were not reset.');return c;}
export function validateWebhook(info){ensure(typeof info?.url==='string'&&(!info.url||info.url===WEBHOOK),'This Bot already uses another webhook. Its configuration was preserved.');return info;}
export function validateGenerated(c,p){ensure(c?.account_id===ACCOUNT&&c.name==='greeny2'&&c.d1_databases?.length===1&&c.d1_databases[0].database_name==='greeny2-db'&&c.d1_databases[0].database_id===p.database_id&&!c.containers&&c.durable_objects?.bindings?.some(b=>b.name==='TELEGRAM_HUB'&&b.class_name==='TelegramHub'),'Unexpected deployment target or missing Telegram binding.');}
export async function atomicJSON(file,value){const temp=file+'.'+randomBytes(6).toString('hex')+'.tmp';try{await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(()=>{});}}
export async function hiddenInput(prompt,{input=process.stdin,outputStream=process.stdout}={}){
 ensure(input.isTTY,'Run this command in an interactive PowerShell window to enter the Bot Token privately.');let muted=false;
 const output=new Writable({write(chunk,_encoding,callback){if(!muted)outputStream.write(chunk);callback();}});
 const rl=createInterface({input,output,terminal:true,historySize:0});
 try{const pending=rl.question(prompt);muted=true;return (await pending).trim();}finally{muted=false;rl.close();outputStream.write('\n');}
}
async function privateConfig(allowPrompt=false){
 try{return validatePrivate(JSON.parse(await fs.readFile(PRIVATE,'utf8')));}catch(error){if(error.code!=='ENOENT')throw error;}
 ensure(allowPrompt,'Telegram is not configured yet. Run setup first.');
 let number=null;try{number=JSON.parse(await fs.readFile(path.join(ROOT,'.greeny2-signal-private.json'),'utf8')).account_number;}catch{}
 ensure(/^\+[1-9][0-9]{7,14}$/.test(number||''),'The preserved customer phone configuration was not found. Preserve the Signal private file and try again.');
 console.log('Enter the BotFather Token for @'+BOT+'. Input is hidden; it is saved only in the ignored private file and Cloudflare Secrets.');
 const token=await hiddenInput('Bot Token (hidden): ');
 return validatePrivate({base_url:BASE,device_id:'esp32-sensor',account_number:number,bot_username:BOT,bot_token:token,webhook_secret:randomBytes(32).toString('hex')});
}
async function telegram(c,method,data={}){
 let response;try{response=await fetch('https://api.telegram.org/bot'+c.bot_token+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new Error('Telegram '+method+' could not connect. Token and raw errors were withheld.');}
 let body;try{body=await response.json();}catch{throw new Error('Telegram '+method+' returned an unreadable response.');}
 ensure(response.ok&&body.ok===true,'Telegram '+method+' failed (HTTP '+response.status+'). Token and private response were withheld.');return body.result;
}
async function identity(c){const me=await telegram(c,'getMe');ensure(me?.is_bot===true&&me.username?.toLowerCase()===BOT&&Number.isSafeInteger(me.id),'The Token does not belong to the selected @'+BOT+'. Nothing was provisioned.');ensure(!c.bot_id||c.bot_id===me.id,'The saved Bot identity changed; original settings were preserved.');validateWebhook(await telegram(c,'getWebhookInfo'));return {...c,bot_id:me.id};}
async function owner(){
 const p=JSON.parse(await fs.readFile(path.join(ROOT,'.greeny2-private.json'),'utf8'));
 ensure(p.account_id===ACCOUNT&&p.deployment_marker==='openezit:greeny2'&&p.cloud?.ws_host===HOST&&p.cloud?.device_id==='esp32-sensor'&&p.admin?.username==='admin'&&typeof p.admin.password==='string'&&p.database_id,'Unexpected own-account Cloud configuration.');return p;
}
let resolvedCloudIP=null;
async function cloudIP(){
 if(resolvedCloudIP)return resolvedCloudIP;
 try{const r=await fetch('https://cloudflare-dns.com/dns-query?name='+HOST+'&type=A',{headers:{accept:'application/dns-json'},signal:AbortSignal.timeout(10000)});const d=await r.json();const a=d.Answer?.find(a=>a.type===1&&String(a.name).replace(/\.$/,'').toLowerCase()===HOST&&isIP(a.data)===4);if(d.Status===0&&a)resolvedCloudIP=a.data;}catch{}
 return resolvedCloudIP;
}
async function cloud(route,{method='GET',headers={},body}={}){
 ensure(route.startsWith('/api/telegram/')||route==='/api/auth/login'||route==='/health','Unexpected Greeny2 API path.');const ip=await cloudIP();
 return await new Promise((resolve,reject)=>{
  const req=httpsRequest({hostname:HOST,servername:HOST,port:443,path:route,method,rejectUnauthorized:true,headers:{accept:'application/json',...headers,...(body?{'Content-Length':Buffer.byteLength(body)}:{})},timeout:20000,...(ip?{lookup:(_host,options,callback)=>options.all?callback(null,[{address:ip,family:4}]):callback(null,ip,4)}:{})},res=>{
   let raw='';res.on('data',chunk=>{raw+=chunk;if(raw.length>65536)req.destroy();});res.on('error',()=>reject(new Error('Greeny2 response interrupted. Private data was withheld.')));res.on('end',()=>{try{resolve({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,body:JSON.parse(raw)});}catch{reject(new Error('Greeny2 returned an unreadable response.'));}});
  });req.on('error',()=>reject(new Error('Greeny2 certificate-verified HTTPS connection failed.')));req.on('timeout',()=>req.destroy());if(body)req.write(body);req.end();
 });
}
async function login(){const p=await owner();const health=await cloud('/health');ensure(health.ok&&health.body.deployment_marker==='openezit:greeny2'&&health.body.status==='ok','Own Greeny2 health check failed.');const r=await cloud('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p.admin)});ensure(r.ok&&typeof r.body.token==='string','Administrator login failed; credentials were preserved.');return r.body.token;}
async function configStatus(jwt){const r=await cloud('/api/telegram/config',{headers:{Authorization:'Bearer '+jwt}});ensure(r.ok&&r.body.read_only===true,'Telegram status could not be verified (HTTP '+r.status+').');return r.body;}
async function configure(c,jwt,pairCode){const digits=c.account_number.replace(/^\+/,'');const r=await cloud('/api/telegram/config',{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt},body:JSON.stringify({enabled:true,device_id:c.device_id,bot_id:c.bot_id,bot_username:c.bot_username,phone_hash:hash(digits),account_mask:'***'+digits.slice(-4),pair_hash:hash(pairCode),pair_expires_ms:Date.now()+3600000})});ensure(r.ok&&r.body.configured===true,'Telegram Cloud configuration failed (HTTP '+r.status+').');return r.body;}
function childEnv(){const env={...process.env,CLOUDFLARE_ACCOUNT_ID:ACCOUNT,WRANGLER_WRITE_LOGS:'false',WRANGLER_LOG_SANITIZE:'true',WRANGLER_SEND_METRICS:'false',NO_COLOR:'1',FORCE_COLOR:'0'};delete env.CLOUDFLARE_API_BASE_URL;delete env.CF_API_BASE_URL;return env;}
async function run(script,args=[],{inherit=false,input=null,timeout=600000}={}){
 return await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script,...args],{cwd:ROOT,env:childEnv(),shell:false,windowsHide:!inherit,stdio:inherit?'inherit':['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>child.kill(),timeout);
 if(!inherit){child.stdout.on('data',b=>{out+=b;if(out.length>8*1024*1024)child.kill();});child.stderr.on('data',b=>{err+=b;if(err.length>8*1024*1024)child.kill();});child.stdin.on('error',()=>{});child.stdin.end(input??'');}
 child.on('error',()=>{clearTimeout(timer);reject(new Error('Could not start '+path.basename(script)+'.'));});child.on('close',code=>{clearTimeout(timer);code===0?resolve(out):reject(new Error(path.basename(script)+' failed (exit '+code+'). Private command output was withheld.'));});});
}
function parsed(text){const clean=text.replace(/\x1b\[[0-9;]*m/g,'').trim();try{return JSON.parse(clean);}catch{}for(let i=0;i<clean.length;i++)if((i===0||clean[i-1]==='\n')&&(clean[i]==='{'||clean[i]==='[')){try{return JSON.parse(clean.slice(i));}catch{}}throw new Error('Unexpected Cloudflare response; private output was withheld.');}
async function secrets(c){
 const p=await owner(),generated=JSON.parse(await fs.readFile(GENERATED,'utf8'));validateGenerated(generated,p);
 const who=parsed(await run(WRANGLER,['whoami','--json','--config',GENERATED]));ensure(who.loggedIn===true&&who.accounts?.some(a=>a.id===ACCOUNT),'Authenticate the intended Cloudflare account first.');
 await run(WRANGLER,['secret','bulk','--config',GENERATED],{input:JSON.stringify({TELEGRAM_BOT_TOKEN:c.bot_token,TELEGRAM_WEBHOOK_SECRET:c.webhook_secret})});
 console.log('Bot Token and webhook secret installed as Cloudflare Secrets. No billing plan was changed.');
}
export function qrSVG(link){ensure(/^https:\/\/t\.me\/greeny2_bot\?start=[A-Za-z0-9_-]{32}$/.test(link),'Invalid private pairing link.');const require=createRequire(import.meta.url),qrcode=require('../signal/vendor/qrcode.cjs'),qr=qrcode(0,'M');qr.addData(link);qr.make();return qr.createSvgTag({cellSize:8,margin:32,scalable:true});}
export function pairPage(link,nonce){const svg=qrSVG(link);return '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Greeny2 Telegram 配對</title><style>body{font-family:system-ui,sans-serif;background:#edf6f1;color:#17362b;margin:0;padding:30px}main{max-width:650px;margin:auto;background:white;border-radius:20px;padding:28px;text-align:center}svg{width:360px;max-width:100%;height:auto;shape-rendering:crispEdges}a{color:#086542;font-weight:bold}p{line-height:1.7}#state{background:#e6f5eb;padding:16px;border-radius:12px;font-size:20px}.small{font-size:14px;color:#476258}</style><main><h1>Greeny2 Telegram 配對</h1><div id="qr">'+svg+'<p><a href="'+link+'" rel="noreferrer">開啟 @greeny2_bot</a></p><p>用手機相機掃 QR，選擇在 Telegram 開啟，再按「Start／開始」。若沒有回覆，可直接傳送 /start。<br>接著按 Bot 的「確認手機號碼」並分享你自己的聯絡資料。</p><p class="small">也可直接在 Bot 輸入 /start。只接受原有客戶手機號碼。</p></div><div id="state">正在核對 Cloud 狀態…</div><p>連結後，請分別按 <b>ec?</b>、<b>temp?</b>、<b>ph?</b>，確認手機收到回覆。<br>此頁及 PowerShell 只用作設定，日後收發由 Cloudflare 處理。</p><p class="small">電腦關機後仍可查詢。過期／離線數據會顯示最後採樣時間。</p></main><script nonce="'+nonce+'">async function check(){try{const r=await fetch("status",{cache:"no-store"});const s=await r.json();const names={ec:"EC",temp:"溫度",ph:"PH"};if(s.paired)document.getElementById("qr").hidden=true;document.getElementById("state").textContent=s.paired?"已連結手機；"+Object.keys(names).map(k=>names[k]+(s.submitted_queries?.[k]?" ✓":" 待測")).join(" ／ "):(s.pairing_stage==="awaiting_contact"&&s.last_pairing_event?.send_status==="webhook_submitted"?"已提交確認按鈕，等待手機分享本人聯絡資料…":"等待手機輸入 /start 並確認號碼…");}catch{}}check();setInterval(check,2000);</script></html>';}
async function pairing(c,jwt,pairCode){
 await fs.mkdir(RUNTIME,{recursive:true});const nonce=randomBytes(18).toString('hex'),pathToken=randomBytes(24).toString('hex'),prefix='/pair/'+pathToken+'/',link='https://t.me/'+BOT+'?start='+pairCode;let status=await configStatus(jwt),host='';
 const page=pairPage(link,nonce);const server=createServer((req,res)=>{
  const origin='http://'+host;if(req.headers.host!==host||req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);res.end();return;}
  const localPath=new URL(req.url,origin).pathname;if(req.method!=='GET'||![prefix,prefix+'status'].includes(localPath)){res.writeHead(404);res.end();return;}
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-"+nonce+"'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Content-Type',localPath===prefix?'text/html; charset=utf-8':'application/json');res.end(localPath===prefix?page:JSON.stringify(status));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));host='127.0.0.1:'+server.address().port;const url='http://'+host+prefix;
 await atomicJSON(path.join(RUNTIME,'pair-session.json'),{url,phase:'waiting',created_utc:new Date().toISOString()});
 console.log('PAIR PAGE: '+url);console.log('Open the local page. Scan the QR with the customer phone camera, open Telegram and share the authorized contact. Then test ec?, temp?, ph?.');
 let last='';const began=Date.now();try{
  while(Date.now()-began<3600000){
   try{status=await configStatus(jwt);}catch{console.log('Cloud status temporarily unavailable; pairing remains on Cloudflare.');await sleep(5000);continue;}
   const phase=status.paired?'paired':'waiting',summary=JSON.stringify([phase,Object.keys(status.submitted_queries||{}).sort()]);if(summary!==last){console.log('Telegram '+phase+'; submitted queries: '+(Object.keys(status.submitted_queries||{}).join(', ')||'pending'));last=summary;await atomicJSON(path.join(RUNTIME,'pair-session.json'),{url,phase,created_utc:new Date(began).toISOString()});}
   if(status.paired&&['ec','temp','ph'].every(k=>status.submitted_queries?.[k])){console.log('RESULT: '+JSON.stringify({cloud_deployed:true,telegram_paired:true,queries_submitted:['ec','temp','ph'],desktop_required:false,paid_plan_enabled:false,firmware_changed:false,phone_reply_confirmation_pending:true}));await sleep(5000);return;}
   await sleep(5000);
  }
  console.log('Pairing monitor ended. Run setup.mjs pair to generate another code; the Cloud webhook remains installed.');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await atomicJSON(path.join(RUNTIME,'pair-session.json'),{url:null,phase:status.paired?'paired':'expired',closed_utc:new Date().toISOString()});}
}
export async function main(stage='setup'){
 ensure(['setup','pair','status','finish'].includes(stage),'Usage: node tools/telegram/setup.mjs setup|pair|status|finish');
 const p=await owner();
 if(stage==='status'||stage==='finish'){
  const s=await configStatus(await login());console.log(JSON.stringify(s,null,2));if(stage==='finish'){ensure(s.paired&&['ec','temp','ph'].every(k=>s.submitted_queries?.[k]),'Complete phone pairing and all three sensor queries first.');await run(path.join(ROOT,'tools/signal/setup.mjs'),['stop'],{inherit:true});console.log('Local Signal autostart stopped. Telegram remains on Cloudflare and this desktop can shut down.');}return;
 }
 let c=await identity(await privateConfig(stage==='setup'));await atomicJSON(PRIVATE,c);
 if(stage==='setup'){
  console.log('Building and deploying the existing own-account Greeny2 Worker. No paid service is enabled.');
  await run(path.join(ROOT,'tools/deploy-openezit.mjs'),['deploy'],{inherit:true});await secrets(c);
 }
 validateGenerated(JSON.parse(await fs.readFile(GENERATED,'utf8')),p);
 const jwt=await login(),pairCode=randomBytes(24).toString('base64url');await configure(c,jwt,pairCode);
 validateWebhook(await telegram(c,'getWebhookInfo'));
 await telegram(c,'setWebhook',{url:WEBHOOK,secret_token:c.webhook_secret,max_connections:1,allowed_updates:['message'],drop_pending_updates:false});
 await telegram(c,'setMyCommands',{commands:[{command:'start',description:'開始 Greeny2 水質查詢'},{command:'help',description:'顯示查詢說明'},{command:'ec',description:'查詢 EC（µS/cm）'},{command:'temp',description:'查詢溫度（°C）'},{command:'ph',description:'查詢 pH'}]});
 const hook=validateWebhook(await telegram(c,'getWebhookInfo'));ensure(hook.url===WEBHOOK,'Telegram webhook URL was not saved.');
 console.log('Cloudflare HTTPS webhook verified for @'+BOT+'. No desktop background bridge is needed. Replies use the Telegram webhook response.');await pairing(c,jwt,pairCode);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv[2]).catch(error=>{console.error('FAILED: '+(error instanceof Error?error.message:'Telegram setup failed.'));process.exitCode=1;});

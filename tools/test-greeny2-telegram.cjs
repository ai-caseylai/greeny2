
/* In-memory regression tests: no network requests, filesystem writes or physical outputs. */
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),{DatabaseSync}=require('node:sqlite');
const root=globalThis.__GREENY_TEST_ROOT__||path.resolve(__dirname,'..');
const requireRepo=createRequire(path.join(root,'spa/package.json')),ts=requireRepo('typescript');
const virtual=globalThis.__GREENY_TEST_FILES__||{};
const read=file=>Object.prototype.hasOwnProperty.call(virtual,file)?virtual[file]:fs.readFileSync(path.join(root,file),'utf8');
const results=[],cache=new Map();
const check=(value,name)=>{if(!value)throw new Error('FAIL: '+name);results.push({name,passed:true});};
class MemoryDO{constructor(ctx,env){this.ctx=ctx;this.env=env;}}
function load(file){
 if(cache.has(file))return cache.get(file);
 const exports={};cache.set(file,exports);
 const js=ts.transpileModule(read(file),{fileName:file,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
 if((js.diagnostics||[]).length)throw new Error('TypeScript syntax error: '+file);
 const dep=name=>{if(name==='cloudflare:workers')return {DurableObject:MemoryDO};if(!name.startsWith('.'))return requireRepo(name);const base=path.posix.normalize(path.posix.join(path.posix.dirname(file),name));return load(base.endsWith('.ts')?base:base+'.ts');};
 new Function('exports','require','module',js.outputText)(exports,dep,{exports});return exports;
}
class MockWS{
 constructor(meta={}){this.meta=structuredClone(meta);this.sent=[];this.readyState=1;}
 serializeAttachment(value){this.meta=structuredClone(value);}deserializeAttachment(){return structuredClone(this.meta);}
 send(raw){if(this.readyState!==1)throw new Error('closed');this.sent.push(JSON.parse(raw));}close(){this.readyState=3;}
}
function d1(db){return {hook:null,prepare(sql){const owner=this;let args=[];return {bind(...values){args=values;return this;},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args),success:true};},async run(){const r=db.prepare(sql).run(...args);if(owner.hook)await owner.hook(sql,args);return {success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};},async batch(items){const rows=[];db.exec('BEGIN');try{for(const item of items)rows.push(await item.run());db.exec('COMMIT');return rows;}catch(error){db.exec('ROLLBACK');throw error;}}};}

class MemoryStorage{
 constructor(){this.rows=new Map();this.alarmAt=null;}
 async get(key){return structuredClone(this.rows.get(key));}
 async put(key,value){this.rows.set(key,structuredClone(value));}
 async delete(key){if(Array.isArray(key)){let n=0;for(const k of key)n+=this.rows.delete(k)?1:0;return n;}return this.rows.delete(key);}
 async list({prefix='',limit=1000}={}){return new Map([...this.rows].filter(([k])=>k.startsWith(prefix)).slice(0,limit));}
 async setAlarm(at){this.alarmAt=at;}
}
(async()=>{
 const originalNow=Date.now,originalFetch=globalThis.fetch;let now=1792108800000;Date.now=()=>now;
 const sends=[];let sensorMode='fresh',sensorCalls=0,outboundCalls=0;
 try{
  const mod=load('edge/src/telegram.ts'),{TelegramHub}=mod,auth=load('edge/src/auth.ts'),worker=load('edge/src/index.ts').default;
  const sql=new DatabaseSync(':memory:');sql.exec(read('edge/db/openezit-schema.sql'));
  sql.exec("INSERT INTO offices(id,name) VALUES(1,'Test');INSERT INTO devices(id,name) VALUES('esp32-sensor','StamPLC');INSERT INTO users(id,username,password_hash,role,office_id) VALUES(1,'admin','unused','superadmin',NULL),(2,'staff','unused','staff',1);");
  const jwt='1'.repeat(64);for(const [k,v]of [['jwt_secret',jwt],['greeny2_deployment_id','openezit:greeny2']])sql.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(k,v);
  const storage=new MemoryStorage(),botToken='123456:'+ 'b'.repeat(35),hookSecret='c'.repeat(64),pairCode='P'.repeat(32),phone='85240000001',phoneHash=await mod.sha256(phone),pairHash=await mod.sha256(pairCode);
  const env={DB:d1(sql),TELEGRAM_BOT_TOKEN:botToken,TELEGRAM_WEBHOOK_SECRET:hookSecret,DEVICE_HUB:{idFromName:id=>id,get:id=>({fetch:async url=>{if(id!=='esp32-sensor'||!String(url).includes('/do-telemetry?'))throw new Error('Unexpected telemetry/hardware route');sensorCalls++;if(sensorMode==='unavailable')return new Response(null,{status:503});return Response.json(sensorMode==='missing'?{status:'error',connected:false}:{status:'ok',connected:sensorMode==='fresh',utc_ms:now-(sensorMode==='fresh'?0:60000),received_ms:now-(sensorMode==='fresh'?0:60000),ec:0,temp:24.6,ph:9.91});}})},GREENY_AGENT:{idFromName:id=>id,get:()=>({fetch:()=>{throw new Error('Unexpected AI or hardware request');}})}};
  let hub=new TelegramHub({storage},env);env.TELEGRAM_HUB={idFromName:id=>id,get:id=>{if(id!=='greeny2-telegram')throw new Error('Wrong DO identity');return{fetch:r=>hub.fetch(r)};}};
  globalThis.fetch=async()=>{outboundCalls++;throw new Error('Unexpected outbound Telegram API request');};
  const admin=await auth.signJWT({sub:1,iat:now/1000},jwt),staff=await auth.signJWT({sub:2,iat:now/1000},jwt),execution={waitUntil(){throw new Error('Unexpected background work');}};
  const request=(route,method='GET',body,token=admin)=>new Request('https://greeny2.openezit.com'+route,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const config={enabled:true,device_id:'esp32-sensor',bot_id:123456,bot_username:'greeny_test_bot',phone_hash:phoneHash,account_mask:'***0001',pair_hash:pairHash,pair_expires_ms:now+900000};
  const update=(id,text,uid=100)=>({update_id:id,message:{message_id:id+1,date:Math.floor(now/1000),chat:{id:uid,type:'private'},from:{id:uid,is_bot:false},...(text!==undefined?{text}:{})}});
  const contact=(id,num,uid=100,contactUid=uid)=>{const u=update(id,undefined,uid);u.message.contact={phone_number:num,user_id:contactUid,first_name:'Test'};return u;};
  const hook=async(body,secret=hookSecret)=>{const response=await worker.fetch(new Request('https://greeny2.openezit.com/api/telegram/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(body)}),env,execution);const result=await response.clone().json();if(result.method==='sendMessage')sends.push(result);return response;};
  const status=async()=>(await worker.fetch(request('/api/telegram/config'),env,execution)).json();
  check((await hook(update(1,'ec?'),'wrong')).status===401&&sends.length===0,'untrusted webhook secret is denied before a reply');
  check((await hook(update(2,'ec?'))).status===200&&sends.length===0,'unconfigured bot ignores queries safely');
  check((await worker.fetch(request('/api/telegram/config','PUT',config,staff),env,execution)).status===403,'staff cannot configure Telegram');
  check((await worker.fetch(request('/api/telegram/config','GET',undefined,staff),env,execution)).status===403,'staff cannot inspect Telegram pairing status');
  check((await worker.fetch(request('/api/telegram/config','PUT',{...config,device_id:'unknown'}),env,execution)).status===400,'configuration rejects an unregistered sensor');
  check((await worker.fetch(request('/api/telegram/config','PUT',{...config,phone_hash:'bad'}),env,execution)).status===400,'configuration requires a hashed authorized phone');
  check((await worker.fetch(request('/api/telegram/config','PUT',config),env,execution)).status===200,'superadmin configures the dedicated Telegram object');
  let s=await status();check(s.configured&&s.enabled&&!s.paired&&s.read_only&&!JSON.stringify(s).includes(phoneHash)&&!JSON.stringify(s).includes(pairHash),'status exposes no phone/pairing hashes or credentials');
  check((await worker.fetch(request('/api/telegram/webhook'),env,execution)).status===405,'webhook accepts POST only');
  await hook(update(3,'ec?'));check(sends.length===0&&sensorCalls===0,'unpaired users cannot read sensor data');
  await hook(update(4,'/start@other_bot '+ 'Z'.repeat(32)));check(sends.length===0,'a start command addressed to another Bot is ignored');
  await hook(update(5,'/start'));check(sends.length===1&&sends.at(-1).reply_markup.keyboard[0][0].request_contact===true,'plain start without a deep-link payload displays the phone confirmation button');
  check((await status()).pairing_stage==='awaiting_contact'&&(await status()).last_pairing_event.send_status==='webhook_submitted','admin diagnostics records the phone prompt submitted via webhook response');
  await hook(contact(6,phone,100,101));check(sends.length===1&&!(await status()).paired,'forwarded/other-person contacts cannot verify the phone');
  await hook(contact(7,'85240000002'));check(!(await status()).paired&&sends.at(-1).text.includes('不符'),'another phone number cannot claim the pairing');
  await hook(contact(8,'+852 4000 0001'));check((await status()).paired&&sends.at(-1).reply_markup.keyboard[0][0].text==='ec?','matching own Telegram contact binds the authorized phone');
  check((await storage.get('config')).pair_hash===null&&!(await storage.get('pending')),'successful pairing consumes the one-time code and pending state');
  const count=sends.length;await hook(update(9,'/start '+pairCode,101));await hook(contact(10,phone,101));await hook(update(11,'ph?',101));check(sends.length===count,'another account cannot replace the bound customer or query it');
  await hook(update(12,'ec?'));check(sends.at(-1).text==='0','EC zero remains a valid numeric reading');
  await hook(update(13,'temp?'));check(sends.at(-1).text==='24.6','temperature query returns the measured one-decimal value');
  await hook(update(14,'ph?'));check(sends.at(-1).text==='9.91','pH query returns the measured two-decimal value');
  s=await status();check(['ec','temp','ph'].every(k=>Number.isSafeInteger(s.submitted_queries[k]))&&s.last_send.answer_available,'submission status records available sensor answers without claiming confirmed delivery');
  await hook(update(15,'/ec@greeny_test_bot'));check(sends.at(-1).text==='0','Telegram slash commands address this Bot correctly');
  const beforeWrongTarget=sends.length;await hook(update(16,'/ph@other_bot'));check(sends.length===beforeWrongTarget,'commands addressed to another Bot are ignored');
  sensorMode='stale';await hook(update(17,'ph?'));check(sends.at(-1).text.includes('最後讀數')&&sends.at(-1).text.includes('香港')&&sends.at(-1).text.includes('9.91'),'offline cached readings carry the real sample time and stale warning');
  sensorMode='missing';await hook(update(18,'temp?'));check(sends.at(-1).text.includes('沒有可用')&&!sends.at(-1).text.includes('24.6'),'missing sensor samples never produce invented numbers');
  sensorMode='unavailable';await hook(update(19,'ec?'));check(sends.at(-1).text.includes('暫時未能')&&(await status()).last_send.answer_available===false,'backend failure is reported and never counted as available sensor verification');
  sensorMode='fresh';const beforeControl=sensorCalls;await hook(update(20,'relay 1 on'));check(sensorCalls===beforeControl&&sends.at(-1).text.includes('水質查詢'),'control requests cannot reach hardware or AI');
  const countBeforeReplay=sends.length;await Promise.all([hook(update(21,'ph?')),hook(update(21,'ph?'))]);check(sends.length===countBeforeReplay+1,'concurrent webhook retries produce a single answer');
  hub=new TelegramHub({storage},env);await hook(update(21,'ph?'));check(sends.length===countBeforeReplay+1&&(await status()).paired,'deduplication and phone binding survive Durable Object restart');
  const beforeBad=sends.length;const group=update(22,'ec?');group.message.chat.type='group';await hook(group);
  const bot=update(23,'ec?');bot.message.from.is_bot=true;await hook(bot);
  const forged=update(24,'ec?');forged.message.from.id=101;await hook(forged);
  const edited={update_id:25,edited_message:update(25,'ec?').message};await hook(edited);
  const old=update(26,'ec?');old.message.date-=121;await hook(old);const future=update(27,'ec?');future.message.date+=6;await hook(future);
  await hook(null);check(sends.length===beforeBad,'groups, bot loops, forged users, edits, old/future and malformed updates are ignored');
  check(outboundCalls===0&&(await status()).delivery_mode==='webhook_response','phone prompts and sensor replies use webhook responses without outbound Bot API connections');
  await storage.put('update:30',{phase:'handling',at:now});const crashCount=sends.length;await hook(update(30,'ec?'));check(sends.length===crashCount,'restart during an indeterminate send does not duplicate an answer');
  const rerun={...config,pair_expires_ms:now+900000};await worker.fetch(request('/api/telegram/config','PUT',rerun),env,execution);check((await status()).paired,'rerunning same installation preserves the paired customer');
  check(!JSON.stringify([...storage.rows]).includes(botToken)&&!JSON.stringify([...storage.rows]).includes(hookSecret)&&!JSON.stringify([...storage.rows]).includes(phone),'Durable Object stores neither Bot token, webhook secret nor full phone number');
  await storage.put('update:old',{phase:'sent',at:now-3*86400000});await hub.alarm();check(!(await storage.get('update:old'))&&await storage.get('update:21'),'alarm prunes old dedup entries while preserving recent ones');
  await worker.fetch(request('/api/telegram/config','PUT',{...rerun,enabled:false}),env,execution);const disabledCount=sends.length;await hook(update(31,'ec?'));check(sends.length===disabledCount,'disabled bot stops answering without changing pairing or sensors');
  await worker.fetch(request('/api/telegram/config','PUT',{...rerun,reset_pair:true}),env,execution);check(!(await status()).paired,'explicit administrator reset is required to remove the binding');
  now+=900001;const expiredCount=sends.length;await hook(update(32,'/start '+pairCode));check(sends.length===expiredCount+1&&!(await status()).paired,'old deep links still request contact and never bypass phone ownership verification');
  now+=900001;const expiredContactCount=sends.length;await hook(contact(33,phone));check(sends.length===expiredContactCount&&!(await status()).paired,'expired phone-confirmation sessions cannot bind an account');
  await hook(update(34,'/start'));await hook(contact(35,phone));check((await status()).paired,'fresh plain start followed by the verified own phone contact completes pairing');
  const malformed=new Request('https://greeny2.openezit.com/api/telegram/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':hookSecret},body:'['});check((await worker.fetch(malformed,env,execution)).status===400,'malformed JSON is rejected safely');
  const oversized=new Request('https://greeny2.openezit.com/api/telegram/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':hookSecret},body:' '.repeat(32769)});check((await worker.fetch(oversized,env,execution)).status===400,'oversized updates cannot enter the Telegram object');
  check(mod.phoneDigits('+852 4000-0001')===phone&&mod.phoneDigits('bad')===null,'phone normalization accepts E.164 formatting and rejects invalid contacts');
  check(sends.every(x=>x.chat_id===100&&x.protect_content===true&&x.method==='sendMessage')&&sensorCalls>0&&outboundCalls===0,'all Telegram replies go only to the authenticated customer private chat');
  console.log(JSON.stringify({passed:results.length,failed:0,tests:results,networkRequests:false,filesystemWrites:false,physicalOutputsTouched:false}));
 }finally{Date.now=originalNow;globalThis.fetch=originalFetch;}
})().catch(error=>{console.error(JSON.stringify({passed:results.length,failed:1,error:error.message,stack:error.stack}));process.exitCode=1;});


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
(async()=>{
 const originalNow=Date.now,NativeResponse=Response,originalPair=globalThis.WebSocketPair;let clock=1792022400000;Date.now=()=>clock;
 try{
  const protocol=load('edge/src/stamplc-protocol.ts'),{DeviceHub}=load('edge/src/device-hub.ts');
  const main=new DatabaseSync(':memory:');main.exec(read('edge/db/openezit-schema.sql'));
  main.exec("PRAGMA foreign_keys=ON; INSERT INTO offices(id,name) VALUES(1,'Office A'),(2,'Office B');INSERT INTO devices(id,name) VALUES('esp32-sensor','StamPLC'),('other-device','Other');INSERT INTO racks(id,name,office_id,device_id) VALUES(1,'Rack A',1,'esp32-sensor'),(2,'Rack B',2,'other-device');INSERT INTO users(id,username,password_hash,role,office_id) VALUES(1,'admin','unused','superadmin',NULL),(2,'staff','unused','staff',1),(3,'officea','unused','office_admin',1),(4,'officeb','unused','office_admin',2);");
  const tds=main.prepare('PRAGMA table_info(telemetry)').all().find(row=>row.name==='tds');check(tds.notnull===0,'fresh D1 schema preserves SQL NULL for unmeasured TDS');
  const local=new DatabaseSync(':memory:'),db=d1(main),promises=[];
  let device=new MockWS({role:'esp32',deviceId:'esp32-sensor',connectedAt:clock,seq:0});
  const dashboard=new MockWS({role:'dashboard',deviceId:'esp32-sensor',userId:2,connectedAt:clock});
  const ctx={webSockets:[device,dashboard],getWebSockets(){return this.webSockets.filter(ws=>ws.readyState===1);},acceptWebSocket(ws){this.webSockets.push(ws);},waitUntil(p){promises.push(Promise.resolve(p));},storage:{sql:{exec(sql,...args){return local.prepare(sql).all(...args);}},async setAlarm(ms){return ms;},async deleteAlarm(){}}};
  let hub=new DeviceHub(ctx,{DB:db});
  const snapshot=async()=>await(await hub.fetch(new Request('https://device-hub/state'))).json();
  const message=async body=>hub.webSocketMessage(device,JSON.stringify({device_id:'esp32-sensor',...body}));
  const body=(channel,state,id=crypto.randomUUID())=>({device_id:'esp32-sensor',command_id:id,channel,state});
  const control=async(actor,command)=>hub.fetch(new Request('https://device-hub/relay-cmd',{method:'POST',headers:{'Content-Type':'application/json','X-Greeny-User-Id':String(actor)},body:JSON.stringify(command)}));
  const sentCommands=()=>device.sent.filter(row=>row.type==='command'&&row.command==='set_relay');
  let s=await snapshot();check(s.ph===null&&s.ec===null&&s.temp===null&&s.utc_ms===null&&s.reported_relays.every(x=>x===null),'missing samples and outputs remain unknown');
  check(protocol.relayRequest(body(1,1))===null&&protocol.relayRequest(body(5,true))===null&&protocol.relayRequest({...body(1,true),device_id:123})===null,'strict boolean, channel and device-id validation');
  check(protocol.sensorSample({ph:7,ec:100,temp:25,tds:null,utc_ms:clock+60000,date_time_hk:protocol.hkTime(clock+60000),esp32_ms:1},clock)===null,'future-dated sample cannot be labelled live');
  check((await control(1,body(1,true))).status===503,'no relay actuation before current-session GPIO hello');
  const session='abcdef0123456789';await message({type:'relay_hello',session_id:session,channels:4,relays:[false,false,false,false],relay_valid:true,utc_ms:clock});
  clock+=100;const sampleUTC=clock;await message({type:'telemetry',ph:9.84,ec:108,temp:32.5,tds:null,utc_ms:sampleUTC,date_time_hk:protocol.hkTime(sampleUTC),esp32_ms:100,session_id:session,relays:[false,false,false,false],relay_valid:true});
  clock+=100;await message({type:'relay_state',session_id:session,relays:[false,false,false,false],relay_valid:true,utc_ms:clock});s=await snapshot();check(s.utc_ms===sampleUTC&&s.ph===9.84&&s.relay_sample_utc_ms===clock,'relay-only reports never advance sensor sample UTC');
  const c1=body(1,true);const accepted=await control(1,c1);check(accepted.status===202,'relay API accepts pending command only');
  let wire=sentCommands().at(-1);s=await snapshot();check(wire.params.channel===1&&wire.params.state===true&&wire.session_id===session&&wire.seq===1&&wire.expires_ms-wire.issued_ms===15000&&s.reported_relays[0]===false&&s.desired_relays[0]===true&&s.pending_relays.length===1,'absolute command has session, sequence, TTL and separate desired/reported state');
  const count=sentCommands().length;check((await control(1,c1)).status===202&&sentCommands().length===count,'same command UUID is idempotent');
  check((await control(1,{...c1,state:false})).status===409,'reused UUID with changed payload is rejected');
  check((await control(2,body(2,true))).status===403&&sentCommands().length===count,'staff relay control denied without hardware command');
  check((await control(4,body(2,true))).status===403,'office administrator cannot control another office device');
  check((await control(1,body(1,false))).status===409,'one active command per relay prevents conflicting updates');
  await hub.webSocketMessage(dashboard,JSON.stringify({command:'set_relay',params:{channel:2,state:true}}));check(dashboard.sent.at(-1).status===403&&sentCommands().length===count,'dashboard WebSocket commands are read-only including staff');
  clock+=100;const ack1={type:'relay_ack',session_id:session,command_id:c1.command_id,seq:wire.seq,channel:1,state:true,status:'applied',relays:[true,false,false,false],relay_valid:true,utc_ms:clock};await message(ack1);s=await snapshot();check(s.reported_relays[0]===true&&s.pending_relays.length===0&&s.utc_ms===sampleUTC,'matching applied ACK confirms GPIO but preserves sensor UTC');
  const reportMs=s.relay_reported_ms;clock+=100;await message(ack1);s=await snapshot();check(s.relay_reported_ms===reportMs,'duplicate terminal ACK cannot refresh GPIO freshness');
  const c2=body(2,true);check((await control(3,c2)).status===202,'own office administrator can control assigned device');const wire2=sentCommands().at(-1);clock+=100;await message({type:'relay_ack',session_id:session,command_id:c2.command_id,seq:wire2.seq,channel:2,state:true,status:'applied',relays:[true,true,false,false],relay_valid:true,utc_ms:clock});
  clock+=100;await message({...ack1,utc_ms:ack1.utc_ms-1});s=await snapshot();check(s.reported_relays[1]===true,'late older ACK cannot regress newer GPIO snapshot');
  const c3=body(3,true);await control(1,c3);clock+=100;await message({type:'telemetry',ph:9.85,ec:109,temp:32.6,tds:null,utc_ms:clock,date_time_hk:protocol.hkTime(clock),esp32_ms:200,session_id:session,relays:[true,true,true,false],relay_valid:true});s=await snapshot();check(!s.pending_relays.some(row=>row.command_id===c3.command_id)&&local.prepare('SELECT status FROM stamplc_commands WHERE command_id=?').get(c3.command_id).status==='observed','fresh current-session GPIO telemetry settles as observed, not ACK');
  const sensorBeforeRelay=s.utc_ms;clock+=100;await message({type:'relay_state',session_id:session,relays:[true,true,true,false],relay_valid:true,utc_ms:clock});check((await snapshot()).utc_ms===sensorBeforeRelay,'independent relay state leaves newer sensor timestamp unchanged');
  const c4=body(4,true);await control(1,c4);const commandsBeforeTTL=sentCommands().length;clock+=16000;await hub.alarm();check(local.prepare('SELECT status FROM stamplc_commands WHERE command_id=?').get(c4.command_id).status==='expired'&&sentCommands().length===commandsBeforeTTL,'expired commands are journalled without replay or actuation');
  const stored=main.prepare('SELECT * FROM telemetry ORDER BY utc_ms DESC LIMIT 1').get();check(stored.tds===null&&stored.utc_ms===sensorBeforeRelay&&stored.date_time_hk===protocol.hkTime(sensorBeforeRelay)&&stored.received_ms!==null,'D1 persists real sample UTC, Hong Kong date and NULL TDS');
  const rowCount=main.prepare('SELECT COUNT(*) AS n FROM telemetry').get().n;local.exec('UPDATE stamplc_samples SET flushed=0');await hub.flush();check(main.prepare('SELECT COUNT(*) AS n FROM telemetry').get().n===rowCount,'D1 flush retry cannot duplicate sample ingest IDs');
  clock+=100;await message({type:'relay_state',session_id:session,relays:[true,true,true,false],relay_valid:true,utc_ms:clock});const race=body(1,false);await control(1,race);const raceWire=sentCommands().at(-1);let injected=false;
  db.hook=async(sql,args)=>{if(!injected&&sql.startsWith('INSERT INTO relay_commands')&&args[0]===race.command_id&&args[8]==='pending'){injected=true;clock+=20;await message({type:'relay_ack',session_id:session,command_id:race.command_id,seq:raceWire.seq,channel:1,state:false,status:'applied',relays:[false,true,true,false],relay_valid:true,utc_ms:clock});}};
  await hub.flush();check(injected&&local.prepare('SELECT flushed FROM stamplc_commands WHERE command_id=?').get(race.command_id).flushed===0,'revision guard retains ACK update racing D1 pending flush');db.hook=null;await hub.flush();check(main.prepare('SELECT status FROM relay_commands WHERE command_id=?').get(race.command_id).status==='applied','next D1 flush persists raced ACK result');
  globalThis.Response=class extends NativeResponse{constructor(data,init){if(init?.status===101){super(null,{status:200});Object.defineProperty(this,'status',{value:101});this.webSocket=init.webSocket;}else super(data,init);}};
  globalThis.WebSocketPair=class{constructor(){this[0]=new MockWS();this[1]=new MockWS();}};
  const priorDevice=device,priorACK=ack1;const reconnected=await hub.fetch(new Request('https://device-hub/device/esp32-sensor',{headers:{Upgrade:'websocket'}}));check(reconnected.status===101,'device connection replacement is accepted internally');device=ctx.webSockets.at(-1);const session2='0123456789abcdef';clock+=100;await message({type:'relay_hello',session_id:session2,channels:4,relays:[false,false,false,false],relay_valid:true,utc_ms:clock});
  await hub.webSocketMessage(priorDevice,JSON.stringify({device_id:'esp32-sensor',...priorACK}));s=await snapshot();check(s.relay_session===session2&&s.reported_relays.every(x=>x===false),'replaced device socket cannot apply stale session ACK');
  const newCommandCount=sentCommands().length;check((await control(1,c1)).status===200&&sentCommands().length===newCommandCount,'old completed UUID cannot reactivate output in a new session');
  const hc=body(1,true);await control(1,hc);const hwire=sentCommands().at(-1),beforeWakeCount=sentCommands().length;hub=new DeviceHub(ctx,{DB:db});s=await snapshot();check(s.relay_session===session2&&s.utc_ms===sensorBeforeRelay&&sentCommands().length===beforeWakeCount,'DO hibernation restores state without resending commands');clock+=100;await message({type:'relay_ack',session_id:session2,command_id:hc.command_id,seq:hwire.seq,channel:1,state:true,status:'applied',relays:[true,false,false,false],relay_valid:true,utc_ms:clock});const hc2=body(2,true);await control(1,hc2);check(sentCommands().at(-1).seq===hwire.seq+1,'session sequence remains monotonic after hibernation');
  main.exec("UPDATE users SET role='staff' WHERE id=3");check((await control(3,body(3,true))).status===403,'permission downgrade is checked before every actuation');
  const auth=load('edge/src/auth.ts'),access=load('edge/src/access.ts'),worker=load('edge/src/index.ts').default;
  main.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('jwt_secret','1111111111111111111111111111111111111111111111111111111111111111');
  const env={DB:db,DEVICE_HUB:{idFromName:id=>id,get:id=>({fetch:request=>hub.fetch(typeof request==='string'?new Request(request):request)})},GREENY_AGENT:{idFromName:id=>id,get:()=>({fetch:()=>{throw new Error('unexpected agent request');}})},AI:{run:async()=>({response:'fixture'})}};
  const execution={waitUntil:p=>promises.push(Promise.resolve(p))};
  check((await worker.fetch(new Request('https://greeny2.openezit.com/health'),env,execution)).status===503,'missing own-deployment marker fails closed');
  main.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('greeny2_deployment_id','openezit:greeny2');const health=await worker.fetch(new Request('https://greeny2.openezit.com/health'),env,execution);const healthBody=await health.json();check(health.status===200&&healthBody.deployment_marker==='openezit:greeny2'&&healthBody.schema_version===2,'health verifies own marker and nullable sensor/relay schema');
  const secret='1111111111111111111111111111111111111111111111111111111111111111';const staffToken=await auth.signJWT({sub:2,role:'superadmin',iat:Math.floor(clock/1000)},secret);
  const request=(route,method='GET',data)=>new Request('https://greeny2.openezit.com'+route,{method,headers:{Authorization:'Bearer '+staffToken,'Content-Type':'application/json'},...(data!==undefined?{body:JSON.stringify(data)}:{})});
  check((await worker.fetch(request('/api/relay','POST',body(3,true)),env,execution)).status===403,'REST uses current staff DB role rather than forged/stale admin JWT claim');
  check((await worker.fetch(request('/api/telemetry?device_id=other-device'),env,execution)).status===403,'staff cannot read another office sensor data');
  const ownRead=await worker.fetch(request('/api/telemetry?device_id=esp32-sensor'),env,execution);check(ownRead.status===200&&(await ownRead.json()).telemetry.every(row=>row.device_id==='esp32-sensor'),'staff may read assigned office sensor data');
  check((await worker.fetch(new Request('https://greeny2.openezit.com/device/esp32-sensor?token=invalid',{headers:{Upgrade:'websocket'}}),env,execution)).status===401,'missing device token configuration never opens device channel');
  const adminToken=await auth.signJWT({sub:1,role:'superadmin',iat:Math.floor(clock/1000)},secret);const adminRequest=route=>new Request('https://greeny2.openezit.com'+route,{headers:{Authorization:'Bearer '+adminToken}});
  for(const route of ['/api/offices','/api/racks','/api/users','/api/crop-batches','/api/harvests','/api/automations','/api/personnel','/api/tasks','/api/notifications','/api/filters','/api/dashboard/stats','/api/reports/summary','/api/reports/usage','/api/relay-logs']){
    const response=await worker.fetch(adminRequest(route),env,execution);check(response.status===200,'Pages management GET port works: '+route);
  }
  const {GreenyAgent}=load('edge/src/agent.ts');let aiInput=null;const agent=new GreenyAgent(ctx,{DEVICE_HUB:env.DEVICE_HUB,AI_MODEL:'@cf/meta/llama-3.1-8b-instruct-fp8-fast',AI:{async run(model,input){aiInput={model,input};return {response:'fixture read-only answer'};}}});
  const beforeAICommands=sentCommands().length;const aiResponse=await agent.fetch(new Request('https://agent/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_id:'esp32-sensor',message:'請讀取資料時間及數值；只查詢。'})}));const aiBody=await aiResponse.json();check(aiResponse.status===200&&aiBody.read_only===true&&Array.isArray(aiInput.input.messages)&&aiInput.input.messages.length===2&&aiInput.input.messages[0].role==='system'&&aiInput.input.messages[1].role==='user'&&!Object.prototype.hasOwnProperty.call(aiInput.input,'tools')&&aiInput.input.messages[0].content.includes(String(sensorBeforeRelay)),'LLM uses chat messages with authoritative sample UTC and no actuation tools');check(sentCommands().length===beforeAICommands,'LLM query never dispatches relay commands');
  const clean=load('edge/src/agent.ts').cleanAnswer;
  check(clean('  pH 9.94; EC 0; 31.5°C  ')==='pH 9.94; EC 0; 31.5°C','LLM answer preserves requested sensor values');
  check(clean('pH 9.94\n\n使用者問題：invented next turn\nanswer')==='pH 9.94','LLM answer removes invented Traditional Chinese turns');
  check(clean('EC 0\nUser: invented next question')==='EC 0','LLM answer removes invented English turns');

  clock+=31000;
  const sensor=load('edge/src/sensor-answer.ts'),signalRoutes=load('edge/src/signal.ts');
  const freshFacts=sensor.sensorFacts({status:'ok',connected:true,utc_ms:clock,received_ms:clock,ec:0,temp:24.6,ph:9.91},'esp32-sensor',clock);
  check(sensor.sensorAnswer('ec',freshFacts)==='0'&&sensor.sensorAnswer('temp',freshFacts)==='24.6'&&sensor.sensorAnswer('ph',freshFacts)==='9.91','short queries return real scalar values including EC zero');
  check(sensor.sensorField(' PH？ ')==='ph'&&sensor.sensorField('temp?')==='temp'&&sensor.sensorField('switch relay 1 on')===null,'query parser recognises sensor questions and rejects relay actions');
  const staleFacts=sensor.sensorFacts({status:'ok',connected:false,utc_ms:clock-60000,received_ms:clock-60000,ec:0,temp:24.6,ph:9.91},'esp32-sensor',clock);
  check(!staleFacts.fresh&&sensor.sensorAnswer('ec',staleFacts).includes('裝置離線')&&sensor.sensorAnswer('ec',staleFacts).includes('最後讀數')&&sensor.sensorAnswer('ec',staleFacts).includes(staleFacts.date_time_hk),'offline sensor answer has enforced stale warning and sample timestamp');
  check(sensor.sensorAnswer('ph',sensor.sensorFacts({status:'error',connected:false},'esp32-sensor',clock)).includes('沒有可用')&&!sensor.sensorAnswer('ph',sensor.sensorFacts({status:'error'},'esp32-sensor',clock)).includes('9.91'),'missing sensor data never invents numeric values');
  check(!sensor.sensorFacts({status:'ok',connected:true,utc_ms:clock,received_ms:clock+60000},'esp32-sensor',clock).fresh,'future receive timestamp cannot make data fresh');
  const bridgeKey='a'.repeat(64),signalSetup={enabled:true,mode:'note_to_self',account_number:'+85240000001',device_id:'esp32-sensor',bridge_key:bridgeKey};
  const signalRequest=(data,key=bridgeKey,method='POST')=>new Request('https://greeny2.openezit.com/api/signal/query',{method,headers:{'Content-Type':'application/json','X-Greeny-Signal-Key':key},...(method==='POST'?{body:JSON.stringify(data)}:{})});
  const sigMessage={kind:'note_to_self',source_number:signalSetup.account_number,message:'ec?',timestamp:clock};
  check((await worker.fetch(signalRequest(sigMessage),env,execution)).status===401,'Signal query fails closed before configuration');
  const staffConfigure=new Request('https://greeny2.openezit.com/api/signal/config',{method:'PUT',headers:{Authorization:'Bearer '+staffToken,'Content-Type':'application/json'},body:JSON.stringify(signalSetup)});
  check((await worker.fetch(staffConfigure,env,execution)).status===403,'staff cannot configure Signal bridge');
  const configureRequest=new Request('https://greeny2.openezit.com/api/signal/config',{method:'PUT',headers:{Authorization:'Bearer '+adminToken,'Content-Type':'application/json'},body:JSON.stringify(signalSetup)});
  const configured=await worker.fetch(configureRequest,env,execution);const configuredBody=await configured.json();
  check(configured.status===200&&configuredBody.configured&&configuredBody.account_mask==='***0001'&&!JSON.stringify(configuredBody).includes(bridgeKey),'admin configures masked Signal status without exposing bridge key');
  const storedSignal=main.prepare("SELECT value FROM settings WHERE key='signal_bridge_config'").get().value;
  check(!storedSignal.includes(bridgeKey)&&JSON.parse(storedSignal).key_hash.length===64,'Cloud stores only hashed Signal bridge secret');
  check((await worker.fetch(signalRequest(sigMessage,'b'.repeat(64)),env,execution)).status===401,'incorrect Signal key is rejected');
  check((await worker.fetch(signalRequest({...sigMessage,source_number:'+85240000000'}),env,execution)).status===403,'other phone numbers cannot query the configured device');
  check((await worker.fetch(signalRequest({...sigMessage,device_id:'other-device'}),env,execution)).status===403,'bridge cannot change its scoped device');
  check((await worker.fetch(signalRequest({...sigMessage,kind:'group'}),env,execution)).status===403,'Signal group queries are rejected');
  check((await worker.fetch(signalRequest({...sigMessage,message:'relay 1 on'}),env,execution)).status===400,'Signal control instructions cannot reach relay routing');
  check((await worker.fetch(signalRequest({...sigMessage,timestamp:clock-120001}),env,execution)).status===400&&(await worker.fetch(signalRequest({...sigMessage,timestamp:clock+5001}),env,execution)).status===400,'expired and future Signal messages are rejected');
  check((await worker.fetch(signalRequest(null),env,execution)).status===400,'malformed Signal JSON fails safely');
  check((await worker.fetch(signalRequest(sigMessage,bridgeKey,'GET'),env,execution)).status===405,'Signal query endpoint requires POST');
  const signalBefore=sentCommands().length,sigResponse=await worker.fetch(signalRequest(sigMessage),env,execution),sigReply=await sigResponse.json();
  check(sigResponse.status===200&&sigReply.read_only===true&&sigReply.value===109&&sigReply.reply.includes('最後讀數')&&sigReply.sample_time_hk===protocol.hkTime(sensorBeforeRelay),'Signal reads actual device data and retains explicit stale metadata');
  check(sentCommands().length===signalBefore,'Signal sensor query never sends a hardware command');
  check((await worker.fetch(new Request('https://greeny2.openezit.com/api/devices',{headers:{Authorization:'Bearer '+bridgeKey}}),env,execution)).status===401,'read-only bridge key grants no administrator REST access');
  const staleAnswer=await agent.fetch(new Request('https://agent/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_id:'esp32-sensor',message:'請描述最新水質。'})}));const staleAnswerBody=await staleAnswer.json();
  check(staleAnswerBody.reply.includes('最後讀數')&&staleAnswerBody.reply.includes('香港')&&staleAnswerBody.ai_used===true,'general LLM answer cannot omit program-enforced stale notice');

  // Resource regression fixtures never connect to Cloudflare or physical outputs.
  function resourceFixture(connected=false){
    const audit=new DatabaseSync(':memory:');audit.exec(read('edge/db/openezit-schema.sql'));
    audit.exec("INSERT INTO users(id,username,password_hash,role,active) VALUES(1,'resource-admin','unused','superadmin',1)");
    const storageDB=new DatabaseSync(':memory:'),queries=[],alarms=[];let armed=null,writes=0;
    const socket=new MockWS({role:'esp32',deviceId:'esp32-sensor',connectedAt:clock,seq:0});
    const context={sockets:connected?[socket]:[],getWebSockets(){return this.sockets.filter(ws=>ws.readyState===1);},waitUntil(p){promises.push(Promise.resolve(p));},storage:{sql:{exec(sql,...args){queries.push({sql,args});if(/^(INSERT|UPDATE|DELETE|CREATE)/.test(sql))writes++;return storageDB.prepare(sql).all(...args);}},async setAlarm(ms){armed=ms;alarms.push(ms);},async deleteAlarm(){armed=null;}}};
    const database=d1(audit),fixture={audit,storageDB,context,database,socket,queries,alarms,hub:null,get armed(){return armed;},get writes(){return writes;},wake(){this.hub=new DeviceHub(context,{DB:database});},async fire(){armed=null;await this.hub.alarm();},async send(data){await this.hub.webSocketMessage(socket,JSON.stringify({device_id:'esp32-sensor',...data}));},async state(){return (await this.hub.fetch(new Request('https://device-hub/state?device_id=esp32-sensor'))).json();}};
    fixture.wake();return fixture;
  }
  function queuedSample(f,id,received=clock){f.storageDB.prepare('INSERT INTO stamplc_samples(ingest_id,device_id,ph,ec,temp,tds,utc_ms,date_time_hk,esp32_ms,received_ms) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'esp32-sensor',7,108,24.6,null,received,protocol.hkTime(received),1,received);}
  const idle=resourceFixture();await idle.fire();check(idle.armed===null&&idle.alarms.length===0,'offline empty hub does not perpetually re-arm alarms');
  const indexedPlans=[
    ['latest sample','SELECT * FROM stamplc_samples ORDER BY received_ms DESC LIMIT 1',[]],
    ['pending commands','SELECT * FROM stamplc_commands WHERE status=? ORDER BY issued_ms',['pending']],
    ['channel history','SELECT state FROM stamplc_commands WHERE channel=? ORDER BY issued_ms DESC LIMIT 1',[1]],
    ['sample queue','SELECT * FROM stamplc_samples WHERE flushed=0 ORDER BY received_ms LIMIT 100',[]],
    ['command queue','SELECT * FROM stamplc_commands WHERE flushed=0 LIMIT 100',[]],
    ['alert queue','SELECT * FROM stamplc_alerts WHERE flushed=0 LIMIT 100',[]],
    ['alert dedup','SELECT id FROM stamplc_alerts WHERE type=? AND created_ms>? LIMIT 1',['ph_abnormal',0]],
    ['recent alerts','SELECT type,severity,message,created_ms FROM stamplc_alerts ORDER BY created_ms DESC LIMIT ?',[10]],
    ['sample pruning','DELETE FROM stamplc_samples WHERE flushed=1 AND received_ms<? AND received_ms<?',[clock-86400000,clock]],
  ];
  for(const [name,sql,args] of indexedPlans){const plan=idle.storageDB.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(row=>row.detail).join('; ');check(/USING.*INDEX/.test(plan)&&!plan.includes('TEMP B-TREE'),'resource query uses index without full-table sort: '+name);}
  const quiet=resourceFixture(true),resourceSession='1234567890abcdef';
  await quiet.send({type:'relay_hello',session_id:resourceSession,channels:4,relays:[false,false,false,false],relay_valid:true,utc_ms:clock});
  const writesBeforeReports=quiet.writes,readsBeforeReports=quiet.queries.length,alarmsBeforeReports=quiet.alarms.length;
  for(let i=0;i<100;i++){clock+=5000;await quiet.send({type:'ping',seq:i});await quiet.send({type:'relay_state',session_id:resourceSession,relays:[false,false,false,false],relay_valid:true,utc_ms:clock});await quiet.state();}
  check(quiet.writes===writesBeforeReports&&quiet.queries.length===readsBeforeReports,'100 heartbeat/readback/snapshot cycles do not repeatedly read or write SQL');
  check(quiet.alarms.length===alarmsBeforeReports,'unchanged reports do not write a fresh alarm for each message');
  quiet.wake();const restored=await quiet.state();check(restored.relay_valid&&restored.relay_session===resourceSession&&restored.relay_reported_ms===clock,'current GPIO freshness and session survive hibernation via WebSocket attachment');

  const timed=resourceFixture(true);await timed.send({type:'relay_hello',session_id:resourceSession,channels:4,relays:[false,false,false,false],relay_valid:true,utc_ms:clock});
  clock+=5000;await timed.send({type:'ping',seq:1});await timed.fire();check(timed.armed===clock+60000,'connected quiet hub schedules minute flush rather than five-second polling');
  await timed.send({type:'relay_state',session_id:resourceSession,relays:[false,false,false,false],relay_valid:true,utc_ms:clock});
  const deadlineCommand=body(1,true),deadlineRequest=new Request('https://device-hub/relay-cmd',{method:'POST',headers:{'Content-Type':'application/json','X-Greeny-User-Id':'1'},body:JSON.stringify(deadlineCommand)});
  const deadlineResponse=await timed.hub.fetch(deadlineRequest),deadlineWire=timed.socket.sent.find(row=>row.type==='command');
  check(deadlineResponse.status===202&&timed.armed===deadlineWire.expires_ms&&timed.armed===clock+15000,'pending command deadline preempts the minute flush without extending its TTL');
  clock=deadlineWire.expires_ms;await timed.fire();check(timed.storageDB.prepare('SELECT status FROM stamplc_commands WHERE command_id=?').get(deadlineCommand.command_id).status==='expired','command expires at its exact deadline after scheduler optimization');
  timed.socket.close();await timed.hub.webSocketClose(timed.socket);clock=timed.armed;await timed.fire();check(timed.armed===null&&timed.audit.prepare("SELECT status FROM devices WHERE id='esp32-sensor'").get().status==='offline','disconnect flushes final offline state and then stops scheduling');

  const backlog=resourceFixture();for(let i=0;i<150;i++)queuedSample(backlog,'backlog-'+i,clock-1000+i);backlog.wake();clock+=5000;await backlog.fire();
  check(backlog.audit.prepare('SELECT COUNT(*) n FROM telemetry').get().n===100&&backlog.armed===clock+60000,'offline backlog larger than one batch remains scheduled');
  clock=backlog.armed;await backlog.fire();check(backlog.audit.prepare('SELECT COUNT(*) n FROM telemetry').get().n===150&&backlog.armed===null,'all remaining backlog is flushed exactly once before the offline alarm stops');
  const offlineReads=backlog.queries.length;for(let i=0;i<20;i++)await backlog.state();check(backlog.queries.length===offlineReads,'repeated offline state reads reuse the pending cache');

  const retrying=resourceFixture();queuedSample(retrying,'retry-sample');retrying.wake();retrying.database.hook=async sql=>{if(sql.startsWith('INSERT INTO telemetry'))throw new Error('Simulated D1 outage');};clock+=5000;
  const savedConsoleError=console.error;try{console.error=()=>{};await retrying.fire();}finally{console.error=savedConsoleError;}
  const retryAt=retrying.armed;check(retryAt===clock+60000&&retrying.storageDB.prepare('SELECT flushed FROM stamplc_samples').get().flushed===0,'failed D1 flush retains data and schedules a one-minute retry');
  retrying.wake();await retrying.fire();check(retrying.armed===retryAt,'flush retry backoff survives hibernation');
  retrying.database.hook=null;clock=retryAt;await retrying.fire();check(retrying.armed===null&&retrying.audit.prepare('SELECT COUNT(*) n FROM telemetry').get().n===1,'retry completes without duplicate ingestion and offline scheduling stops');

  const retained=resourceFixture();for(let i=0;i<3;i++)queuedSample(retained,'old-'+i,clock-2*86400000+i);retained.wake();clock+=5000;await retained.fire();retained.wake();const retainedState=await retained.state();
  check(retained.storageDB.prepare('SELECT COUNT(*) n FROM stamplc_samples').get().n===1&&retainedState.ec===108&&retainedState.sample_stale&&retained.audit.prepare('SELECT COUNT(*) n FROM telemetry').get().n===3,'pruning keeps the newest offline sample and preserves the full flushed D1 history');
  const migrated=resourceFixture();queuedSample(migrated,'migration-preserved');migrated.storageDB.exec("DELETE FROM stamplc_meta WHERE key='query_indexes_v2'");for(const row of migrated.storageDB.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'stamplc_%'").all())migrated.storageDB.exec('DROP INDEX '+row.name);migrated.wake();
  check(migrated.storageDB.prepare('SELECT COUNT(*) n FROM stamplc_samples').get().n===1&&migrated.storageDB.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name LIKE 'stamplc_%'").get().n===8,'additive index upgrade preserves existing sensor records');

  check(main.prepare('PRAGMA foreign_key_check').all().length===0,'fresh schema retains foreign-key integrity after ingestion and relay audit');
  await Promise.all(promises);console.log(JSON.stringify({passed:results.length,failed:0,tests:results,typescript:ts.version,physicalOutputsTouched:false,cloudMutations:false,filesystemWrites:false}));
 }finally{Date.now=originalNow;globalThis.Response=NativeResponse;globalThis.WebSocketPair=originalPair;}
})().catch(error=>{console.error(JSON.stringify({passed:results.length,failed:1,error:error.message,stack:error.stack}));process.exitCode=1;});

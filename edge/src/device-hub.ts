
import { DurableObject } from 'cloudflare:workers';
import { DEVICE_ID_RE, SESSION_RE, RELAY_TTL_MS, RELAY_REPORT_FRESH_MS, SAMPLE_FRESH_MS, relayValues, relayRequest, sensorSample, json, type RelayValues, type RelayRequest, type SensorSample } from './stamplc-protocol';
interface HubEnv { DB: D1Database; }
interface RelayState {session_id:string|null;relays:RelayValues;relay_valid:boolean;relay_reported_ms:number;relay_sample_utc_ms:number;relay_last_seq:number;last_inbound_ms:number;}
interface Peer { role:'esp32'|'dashboard'; deviceId:string; connectedAt:number; userId?:number; sessionId?:string; seq?:number; relayState?:RelayState; }
interface Command extends RelayRequest { session_id:string; seq:number; issued_ms:number; expires_ms:number; status:string; actor_id:number; reason:string|null; reported_relays_json:string|null; relay_valid:number; acked_utc_ms:number|null; updated_ms:number; }
const UNKNOWN = ():RelayValues => [null,null,null,null];
export class DeviceHub extends DurableObject<HubEnv> {
  private device: WebSocket|null = null;
  private deviceId = '';
  private sample: SensorSample|null = null;
  private reported = UNKNOWN();
  private desired = UNKNOWN();
  private relayValid = false;
  private relayReportedMs = 0;
  private relaySampleUtc = 0;
  private lastRelaySeq = 0;
  private relaySession: string|null = null;
  private lastInboundMs = 0;
  private pendingCache: Command[]|null = null;
  private alarmAt: number|null = null;
  private nextFlushMs = 0;
  private needsFlush = false;
  private dirtyRevision = 0;
  private thresholds = {phMin:5.5,phMax:8.5,ecMax:2000,tempMin:18,tempMax:30};
  constructor(ctx:DurableObjectState, env:HubEnv) {
    super(ctx,env);
    const sql=ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS stamplc_samples (ingest_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,ph REAL NOT NULL,ec REAL NOT NULL,temp REAL NOT NULL,tds REAL,utc_ms INTEGER NOT NULL,date_time_hk TEXT NOT NULL,esp32_ms INTEGER NOT NULL,received_ms INTEGER NOT NULL,relays_json TEXT,relay_valid INTEGER NOT NULL DEFAULT 0,relay_session TEXT,flushed INTEGER NOT NULL DEFAULT 0)');
    sql.exec('CREATE TABLE IF NOT EXISTS stamplc_commands (command_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,session_id TEXT NOT NULL,seq INTEGER NOT NULL,channel INTEGER NOT NULL,state INTEGER NOT NULL,issued_ms INTEGER NOT NULL,expires_ms INTEGER NOT NULL,status TEXT NOT NULL,actor_id INTEGER NOT NULL,reason TEXT,reported_relays_json TEXT,relay_valid INTEGER NOT NULL DEFAULT 0,acked_utc_ms INTEGER,updated_ms INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0,flushed INTEGER NOT NULL DEFAULT 0)');
    sql.exec('CREATE TABLE IF NOT EXISTS stamplc_alerts (id TEXT PRIMARY KEY,device_id TEXT NOT NULL,type TEXT NOT NULL,severity TEXT NOT NULL,message TEXT NOT NULL,created_ms INTEGER NOT NULL,flushed INTEGER NOT NULL DEFAULT 0)');
    sql.exec('CREATE TABLE IF NOT EXISTS stamplc_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    if(![...sql.exec('SELECT value FROM stamplc_meta WHERE key=?','query_indexes_v2')][0]){
      // Index only the queues and orderings actually queried. A partial queue index
      // stays small after records have been flushed, even with a large history.
      sql.exec('CREATE INDEX IF NOT EXISTS stamplc_samples_recent ON stamplc_samples(received_ms DESC)');
      sql.exec('CREATE INDEX IF NOT EXISTS stamplc_samples_unflushed ON stamplc_samples(received_ms) WHERE flushed=0');
      sql.exec('CREATE INDEX IF NOT EXISTS stamplc_commands_status_time ON stamplc_commands(status,issued_ms)');
      sql.exec('CREATE INDEX IF NOT EXISTS stamplc_commands_channel_time ON stamplc_commands(channel,issued_ms DESC)');
      sql.exec('CREATE INDEX IF NOT EXISTS stamplc_commands_unflushed ON stamplc_commands(command_id) WHERE flushed=0');
      sql.exec('CREATE INDEX IF NOT EXISTS stamplc_alerts_unflushed ON stamplc_alerts(id) WHERE flushed=0');
      sql.exec('CREATE INDEX IF NOT EXISTS stamplc_alerts_type_time ON stamplc_alerts(type,created_ms DESC)');
      sql.exec('CREATE INDEX IF NOT EXISTS stamplc_alerts_recent ON stamplc_alerts(created_ms DESC)');
      sql.exec('INSERT OR REPLACE INTO stamplc_meta(key,value) VALUES(?,?)','query_indexes_v2','1');
    }
    const latest=[...sql.exec('SELECT * FROM stamplc_samples ORDER BY received_ms DESC LIMIT 1')][0];
    if(latest){this.deviceId=String(latest.device_id);this.sample=this.rowSample(latest);}
    const saved=[...sql.exec('SELECT value FROM stamplc_meta WHERE key=?','thresholds')][0];
    if(saved){try{this.thresholds=JSON.parse(String(saved.value));}catch{}}
    for(const ws of ctx.getWebSockets()){
      const peer=ws.deserializeAttachment() as Peer|null;
      if(peer?.role==='esp32'){
        this.device=ws;this.deviceId=peer.deviceId;this.relaySession=peer.sessionId||null;
        // Attachments survive WebSocket hibernation without a SQL write for every
        // ping/GPIO report. Read the old SQL state only for pre-upgrade sockets.
        const state=peer.relayState?null:[...sql.exec('SELECT value FROM stamplc_meta WHERE key=?','relay_state')][0];
        try{const value=peer.relayState||(state?JSON.parse(String(state.value)):null);if(value&&value.session_id===this.relaySession){this.reported=value.relays;this.relayValid=value.relay_valid;this.relayReportedMs=value.relay_reported_ms;this.relaySampleUtc=value.relay_sample_utc_ms||0;this.lastRelaySeq=value.relay_last_seq||0;this.lastInboundMs=value.last_inbound_ms;}}catch{}
      }
    }
    for(let channel=1;channel<=4;channel++){
      const row=[...sql.exec('SELECT state FROM stamplc_commands WHERE channel=? ORDER BY issued_ms DESC LIMIT 1',channel)][0];
      if(row)this.desired[channel-1]=row.state===1;
    }
    const last=[...sql.exec('SELECT value FROM stamplc_meta WHERE key=?','last_flush_ms')][0];
    const retry=[...sql.exec('SELECT value FROM stamplc_meta WHERE key=?','flush_retry_at')][0];
    this.nextFlushMs=Math.max(last?Number(last.value)+60000:Date.now()+5000,retry?Number(retry.value):0);
    this.needsFlush=this.hasBuffered();
  }
  private rowSample(row:any):SensorSample { return {ph:Number(row.ph),ec:Number(row.ec),temp:Number(row.temp),tds:row.tds===null?null:Number(row.tds),utc_ms:Number(row.utc_ms),date_time_hk:String(row.date_time_hk),esp32_ms:Number(row.esp32_ms),received_ms:Number(row.received_ms)}; }
  private saveRelay(){
    const peer=this.device?.deserializeAttachment() as Peer|null;
    if(!peer||peer.role!=='esp32')return;
    peer.relayState={session_id:this.relaySession,relays:this.reported,relay_valid:this.relayValid,relay_reported_ms:this.relayReportedMs,relay_sample_utc_ms:this.relaySampleUtc,relay_last_seq:this.lastRelaySeq,last_inbound_ms:this.lastInboundMs};
    this.device!.serializeAttachment(peer);
  }
  private send(ws:WebSocket,data:unknown){try{ws.send(JSON.stringify(data));}catch{}}
  private broadcast(data:unknown){for(const ws of this.ctx.getWebSockets()){const p=ws.deserializeAttachment() as Peer|null;if(p?.role==='dashboard')this.send(ws,data);}}
  private markDirty(){this.needsFlush=true;this.dirtyRevision++;}
  private commandChanged(){this.pendingCache=null;this.markDirty();}
  private hasBuffered():boolean{
    return ['stamplc_samples','stamplc_commands','stamplc_alerts'].some(table=>[...this.ctx.storage.sql.exec('SELECT 1 FROM '+table+' WHERE flushed=0 LIMIT 1')].length>0);
  }
  private pending():Command[]{
    if(this.pendingCache===null)this.pendingCache=[...this.ctx.storage.sql.exec('SELECT * FROM stamplc_commands WHERE status=? ORDER BY issued_ms','pending')].map(row=>({...row,state:row.state===1} as unknown as Command));
    return this.pendingCache;
  }
  private snapshot(){
    const now=Date.now(), connected=!!this.device&&this.device.readyState===1;
    const relayValid=connected&&this.relayValid&&now-this.relayReportedMs<=RELAY_REPORT_FRESH_MS;
    const sampleStale=!this.sample||now-this.sample.received_ms>SAMPLE_FRESH_MS||now-this.sample.utc_ms>SAMPLE_FRESH_MS||this.sample.utc_ms>now+2000;
    return {type:'state',device_id:this.deviceId,connected,device_connected:connected,ph:this.sample?.ph??null,ec:this.sample?.ec??null,temp:this.sample?.temp??null,water_temp:this.sample?.temp??null,tds:this.sample?.tds??null,utc_ms:this.sample?.utc_ms??null,date_time_hk:this.sample?.date_time_hk??null,received_ms:this.sample?.received_ms??null,doTs:this.sample?.received_ms??null,server_ms:now,esp32_ms:this.sample?.esp32_ms??null,sample_valid:!!this.sample&&!sampleStale&&connected,sample_stale:sampleStale,reported_relays:this.reported,relays:this.reported,desired_relays:this.desired,pending_relays:this.pending(),relay_valid:relayValid,relay_reported_ms:this.relayReportedMs||null,relay_sample_utc_ms:this.relaySampleUtc||null,relay_session:this.relaySession,relay_readback:'gpio'};
  }
  private emitState(){this.broadcast(this.snapshot());}
  private planAlarm(){
    const now=Date.now(),deadlines=this.pending().map(command=>command.expires_ms);
    if(this.device?.readyState===1){deadlines.push(this.nextFlushMs);if(this.lastInboundMs)deadlines.push(this.lastInboundMs+90001);}
    else if(this.needsFlush&&this.deviceId)deadlines.push(this.nextFlushMs);
    if(!deadlines.length){
      if(this.alarmAt!==null){this.alarmAt=null;this.ctx.waitUntil(this.ctx.storage.deleteAlarm());}
      return;
    }
    const at=Math.max(now+1,Math.min(...deadlines));
    if(at===this.alarmAt)return;
    this.alarmAt=at;
    this.ctx.waitUntil(this.ctx.storage.setAlarm(at).catch(error=>{if(this.alarmAt===at)this.alarmAt=null;throw error;}));
  }
  private expirePending(reason='expired',all=false){
    const now=Date.now();
    for(const command of this.pending())if(all||command.expires_ms<=now){
      this.ctx.storage.sql.exec('UPDATE stamplc_commands SET revision=revision+1,status=?,reason=?,updated_ms=?,flushed=0 WHERE command_id=?',all?'interrupted':'expired',reason,now,command.command_id);
      this.commandChanged();
      this.broadcast({type:'relay_result',device_id:this.deviceId,command_id:command.command_id,channel:command.channel,state:command.state,status:all?'interrupted':'expired',reason});
    }
  }
  async fetch(request:Request):Promise<Response>{
    const url=new URL(request.url);
    const requested=url.searchParams.get('device_id');if(requested&&DEVICE_ID_RE.test(requested)&&!this.deviceId)this.deviceId=requested;
    if(requested&&requested!==this.deviceId)return json({error:'Wrong device'},404);
    if(url.pathname==='/state')return json(this.snapshot());
    if(url.pathname==='/do-telemetry'){
      const state=this.snapshot();
      return json(this.sample?{...state,status:'ok',do_ms:state.received_ms}:{device_id:this.deviceId,status:'no_data',utc_ms:null,date_time_hk:null,received_ms:null});
    }
    if(url.pathname==='/do-alerts'){
      const n=Math.max(1,Math.min(50,Number(url.searchParams.get('limit'))||10));
      return json({alerts:[...this.ctx.storage.sql.exec('SELECT type,severity,message,created_ms FROM stamplc_alerts ORDER BY created_ms DESC LIMIT ?',n)]});
    }
    if(url.pathname==='/relay-cmd'&&request.method==='POST')return this.control(request);
    if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'Not found'},404);
    const parts=url.pathname.split('/').filter(Boolean);
    if(parts.length!==2||!['device','dashboard'].includes(parts[0])||!DEVICE_ID_RE.test(parts[1]))return json({error:'Not found'},404);
    const pair=new WebSocketPair(),client=pair[0],server=pair[1];
    const peer:Peer={role:parts[0]==='device'?'esp32':'dashboard',deviceId:parts[1],connectedAt:Date.now(),seq:0};
    if(peer.role==='dashboard'){
      const uid=Number(request.headers.get('X-Greeny-User-Id'));
      if(!Number.isSafeInteger(uid)||uid<1)return json({error:'Unauthorized'},401);
      peer.userId=uid;
    }
    server.serializeAttachment(peer);this.ctx.acceptWebSocket(server);this.deviceId=peer.deviceId;
    if(peer.role==='esp32'){
      const previous=this.device;this.expirePending('device reconnected',true);
      this.device=server;this.relaySession=null;this.relayValid=false;this.relayReportedMs=0;this.relaySampleUtc=0;this.lastRelaySeq=0;this.reported=UNKNOWN();this.lastInboundMs=Date.now();this.saveRelay();
      if(previous&&previous!==server){try{previous.close(1000,'Replaced by new authenticated device connection');}catch{}}
      this.send(server,{type:'sync',device_id:this.deviceId,require_relay_hello:true,doTs:Date.now()});
      this.broadcast({type:'device_status',device_id:this.deviceId,status:'online'});this.emitState();
    }else this.send(server,this.snapshot());
    this.planAlarm();return new Response(null,{status:101,webSocket:client});
  }
  async webSocketMessage(ws:WebSocket,raw:string|ArrayBuffer){
    const peer=ws.deserializeAttachment() as Peer|null;
    if(typeof raw!=='string'||raw.length>8192)return;
    let message:any;try{message=JSON.parse(raw);}catch{return;}
    if(peer?.role==='dashboard'){
      if(message.type==='ping')this.send(ws,{type:'pong',seq:message.seq});
      else this.send(ws,{type:'error',code:'read_only_websocket',status:403,message:'Use the authorized relay API; dashboard WebSockets are read-only.'});
      return;
    }
    if(peer?.role!=='esp32'||ws!==this.device||message.device_id!==peer.deviceId)return;
    const now=Date.now();
    if(message.type==='ping'){this.lastInboundMs=now;this.send(ws,{type:'pong',seq:message.seq});this.saveRelay();return;}
    if(message.type==='relay_hello'){
      const values=relayValues(message.relays,message.relay_valid);
      if(message.channels!==4||typeof message.session_id!=='string'||!SESSION_RE.test(message.session_id)||!values)return;
      if(peer.sessionId&&peer.sessionId!==message.session_id){this.send(ws,{type:'error',code:'session_change_requires_reconnect'});return;}
      if(peer.sessionId)return;
      if(!peer.sessionId){this.expirePending('new relay session',true);peer.sessionId=message.session_id;peer.seq=0;ws.serializeAttachment(peer);this.relaySession=peer.sessionId;}
      this.lastInboundMs=now;this.readback(message,now);this.planAlarm();return;
    }
    if(message.type==='relay_state'){if(message.session_id===this.relaySession&&peer.sessionId===this.relaySession){this.lastInboundMs=now;this.readback(message,now);}return;}
    if(message.type==='relay_ack'){this.acknowledge(message,peer,now);return;}
    if(message.type==='telemetry'){
      const sample=sensorSample(message,now);
      if(!sample){this.send(ws,{type:'error',code:'invalid_sensor_sample'});return;}
      this.lastInboundMs=now;this.sample=sample;
      const suppliedSession=message.session_id??message.relay_session;
      if(suppliedSession===this.relaySession&&this.relaySession)this.readback({...message,session_id:suppliedSession},now,false);
      const id=crypto.randomUUID();
      this.ctx.storage.sql.exec('INSERT INTO stamplc_samples(ingest_id,device_id,ph,ec,temp,tds,utc_ms,date_time_hk,esp32_ms,received_ms,relays_json,relay_valid,relay_session) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',id,this.deviceId,sample.ph,sample.ec,sample.temp,sample.tds,sample.utc_ms,sample.date_time_hk,sample.esp32_ms,now,JSON.stringify(this.reported),this.relayValid?1:0,this.relaySession);
      this.markDirty();
      this.alerts(sample);this.saveRelay();this.emitState();
      this.broadcast({...this.snapshot(),type:'telemetry_update',data:{ph:sample.ph,ec:sample.ec,temp:sample.temp,water_temp:sample.temp,tds:sample.tds,utc_ms:sample.utc_ms,date_time_hk:sample.date_time_hk,received_ms:now},ts_ms:sample.utc_ms});
      this.send(ws,{type:'telemetry_ack',ingest_id:id,utc_ms:sample.utc_ms,received_ms:now,status:'buffered'});
      this.planAlarm();
    }
  }
  private readback(message:any,now:number,emit=true){
    if(!this.relaySession||message.session_id!==this.relaySession)return false;
    const values=relayValues(message.relays,message.relay_valid);if(!values)return false;
    if(this.relaySampleUtc>0&&(!Number.isSafeInteger(message.utc_ms)||message.utc_ms<=this.relaySampleUtc))return false;
    if(Number.isSafeInteger(message.utc_ms)&&(message.utc_ms<now-RELAY_REPORT_FRESH_MS||message.utc_ms>now+2000))return false;
    if(Number.isSafeInteger(message.utc_ms))this.relaySampleUtc=message.utc_ms;
    this.reported=values;this.relayValid=message.relay_valid;this.relayReportedMs=now;
    const sampleUtc=message.utc_ms;
    if(this.relayValid&&Number.isSafeInteger(sampleUtc)&&sampleUtc<=now+5000&&sampleUtc>=now-RELAY_REPORT_FRESH_MS){
      for(const command of this.pending())if(command.session_id===this.relaySession&&sampleUtc>=command.issued_ms&&command.expires_ms>now&&values[command.channel-1]===command.state){
        this.ctx.storage.sql.exec('UPDATE stamplc_commands SET revision=revision+1,status=?,reason=?,reported_relays_json=?,relay_valid=1,acked_utc_ms=?,updated_ms=?,flushed=0 WHERE command_id=?','observed','Fresh GPIO report matches requested state',JSON.stringify(values),sampleUtc,now,command.command_id);
        this.commandChanged();
        this.broadcast({type:'relay_result',device_id:this.deviceId,command_id:command.command_id,channel:command.channel,state:command.state,status:'observed',relays:values,relay_valid:true,utc_ms:sampleUtc});
      }
    }
    this.saveRelay();if(emit)this.emitState();return true;
  }
  private acknowledge(message:any,peer:Peer,now:number){
    const row=[...this.ctx.storage.sql.exec('SELECT * FROM stamplc_commands WHERE command_id=?',String(message.command_id||''))][0] as any;
    if(!row||!peer.sessionId||peer.sessionId!==this.relaySession||message.session_id!==peer.sessionId||row.session_id!==peer.sessionId||message.seq!==row.seq||message.channel!==row.channel||typeof message.state!=='boolean'||message.state!==(row.state===1)||!['applied','rejected','error'].includes(message.status))return;
    const values=relayValues(message.relays,message.relay_valid);if(!values)return;
    if(message.status==='applied'&&(!message.relay_valid||values[row.channel-1]!==message.state||!Number.isSafeInteger(message.utc_ms)||message.utc_ms<row.issued_ms-2000||message.utc_ms>row.expires_ms+2000))return;
    if(row.status===message.status&&row.acked_utc_ms===message.utc_ms)return;
    this.lastInboundMs=now;
    const freshUtc=Number.isSafeInteger(message.utc_ms)&&message.utc_ms>=now-RELAY_REPORT_FRESH_MS&&message.utc_ms<=now+2000;
    if(freshUtc&&(message.utc_ms>this.relaySampleUtc||(message.utc_ms===this.relaySampleUtc&&message.seq>this.lastRelaySeq))){this.reported=values;this.relayValid=message.relay_valid;this.relayReportedMs=now;this.relaySampleUtc=message.utc_ms;this.lastRelaySeq=Math.max(this.lastRelaySeq,message.seq);}
    const reason=typeof message.reason==='string'?message.reason.slice(0,160):null;
    this.ctx.storage.sql.exec('UPDATE stamplc_commands SET revision=revision+1,status=?,reason=?,reported_relays_json=?,relay_valid=?,acked_utc_ms=?,updated_ms=?,flushed=0 WHERE command_id=?',message.status,reason,JSON.stringify(values),message.relay_valid?1:0,Number.isSafeInteger(message.utc_ms)?message.utc_ms:null,now,row.command_id);
    this.commandChanged();
    this.saveRelay();this.broadcast({...message,type:'relay_ack',device_id:this.deviceId,relays:this.reported,reported_relays:this.reported,relay_valid:this.relayValid,ack_relays:values,relay_reported_ms:this.relayReportedMs,acked_utc_ms:message.utc_ms??null,reason});this.emitState();this.planAlarm();
  }
  private async control(request:Request):Promise<Response>{
    const actorId=Number(request.headers.get('X-Greeny-User-Id'));
    if(!Number.isSafeInteger(actorId)||actorId<1)return json({error:'Forbidden'},403);
    let body:any;try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}
    const command=relayRequest(body);if(command&&!this.deviceId)this.deviceId=command.device_id;if(!command||command.device_id!==this.deviceId)return json({error:'Valid device_id, UUID command_id, channel 1–4 and boolean state required'},400);
    const actor=await this.env.DB.prepare('SELECT role,office_id FROM users WHERE id=? AND active=1').bind(actorId).first<any>();
    if(!actor||!['superadmin','office_admin'].includes(actor.role))return json({error:'Read-only account'},403);
    if(actor.role==='office_admin'){
      const owned=await this.env.DB.prepare('SELECT 1 AS owned FROM racks WHERE device_id=? AND office_id=? LIMIT 1').bind(this.deviceId,actor.office_id??-1).first();
      if(!owned)return json({error:'Device outside assigned office'},403);
    }
    let old:any=[...this.ctx.storage.sql.exec('SELECT * FROM stamplc_commands WHERE command_id=?',command.command_id)][0];
    if(!old)old=await this.env.DB.prepare('SELECT * FROM relay_commands WHERE command_id=?').bind(command.command_id).first();
    if(old){if(old.device_id!==command.device_id||old.channel!==command.channel||Boolean(old.state)!==command.state)return json({error:'command_id already used with different parameters'},409);return json({accepted:old.status==='pending',command_id:command.command_id,status:old.status,expires_ms:old.expires_ms,state:this.snapshot()},old.status==='pending'?202:200);}
    // Recheck after D1 awaits: a reconnect, duplicate request or another channel command may have intervened.
    old=[...this.ctx.storage.sql.exec('SELECT * FROM stamplc_commands WHERE command_id=?',command.command_id)][0];
    if(old){if(old.device_id!==command.device_id||old.channel!==command.channel||Boolean(old.state)!==command.state)return json({error:'command_id already used with different parameters'},409);return json({accepted:old.status==='pending',command_id:command.command_id,status:old.status,expires_ms:old.expires_ms,state:this.snapshot()},old.status==='pending'?202:200);}
    this.expirePending();
    const now=Date.now(),peer=this.device?.deserializeAttachment() as Peer|null;
    if(!this.device||this.device.readyState!==1||!peer?.sessionId||peer.sessionId!==this.relaySession||!this.relayValid||now-this.relayReportedMs>RELAY_REPORT_FRESH_MS)return json({error:'Device offline or GPIO report not ready'},503);
    if(this.pending().some(x=>x.channel===command.channel))return json({error:'This relay already has a pending command'},409);
    const seq=(peer.seq||0)+1;if(!Number.isSafeInteger(seq))return json({error:'New device session required'},503);
    const expires=now+RELAY_TTL_MS;
    this.ctx.storage.sql.exec('INSERT INTO stamplc_commands(command_id,device_id,session_id,seq,channel,state,issued_ms,expires_ms,status,actor_id,updated_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)',command.command_id,this.deviceId,peer.sessionId,seq,command.channel,command.state?1:0,now,expires,'pending',actorId,now);
    this.commandChanged();
    peer.seq=seq;this.device.serializeAttachment(peer);this.desired[command.channel-1]=command.state;
    try{this.device.send(JSON.stringify({type:'command',command:'set_relay',device_id:this.deviceId,command_id:command.command_id,session_id:peer.sessionId,seq,issued_ms:now,expires_ms:expires,params:{channel:command.channel,state:command.state}}));}
    catch{this.ctx.storage.sql.exec('UPDATE stamplc_commands SET revision=revision+1,status=?,reason=?,updated_ms=?,flushed=0 WHERE command_id=?','error','send failed',Date.now(),command.command_id);this.commandChanged();this.emitState();this.planAlarm();return json({error:'Device send failed',command_id:command.command_id},503);}
    this.emitState();this.planAlarm();return json({accepted:true,command_id:command.command_id,status:'pending',issued_ms:now,expires_ms:expires,state:this.snapshot()},202);
  }
  private alerts(sample:SensorSample){
    const a:Array<{type:string;message:string}>=[],t=this.thresholds;
    if(sample.ph<t.phMin||sample.ph>t.phMax)a.push({type:'ph_abnormal',message:'pH '+sample.ph+' outside '+t.phMin+'–'+t.phMax});
    if(sample.ec>t.ecMax)a.push({type:'ec_high',message:'EC '+sample.ec+' µS/cm exceeds '+t.ecMax});
    if(sample.temp<t.tempMin||sample.temp>t.tempMax)a.push({type:'temp_abnormal',message:'Temperature '+sample.temp+'°C outside '+t.tempMin+'–'+t.tempMax});
    for(const alert of a){
      if([...this.ctx.storage.sql.exec('SELECT id FROM stamplc_alerts WHERE type=? AND created_ms>? LIMIT 1',alert.type,Date.now()-1800000)].length)continue;
      this.ctx.storage.sql.exec('INSERT INTO stamplc_alerts(id,device_id,type,severity,message,created_ms) VALUES(?,?,?,?,?,?)',crypto.randomUUID(),this.deviceId,alert.type,'warning',alert.message,Date.now());
      this.markDirty();
      this.broadcast({type:'alert',device_id:this.deviceId,alert_type:alert.type,severity:'warning',message:alert.message});
    }
  }
  async alarm(){
    this.alarmAt=null;
    this.expirePending();const now=Date.now();
    if(this.device&&this.lastInboundMs&&now-this.lastInboundMs>90000){try{this.device.close(1000,'Heartbeat timeout');}catch{}this.disconnect(this.device);}
    if(this.deviceId&&(this.device?.readyState===1||this.needsFlush)&&now>=this.nextFlushMs){
      const revision=this.dirtyRevision;
      try{
        await this.flush();
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO stamplc_meta(key,value) VALUES(?,?)','last_flush_ms',String(now));
        this.needsFlush=revision!==this.dirtyRevision||this.hasBuffered();
      }catch(error){
        this.needsFlush=true;
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO stamplc_meta(key,value) VALUES(?,?)','flush_retry_at',String(Date.now()+60000));
        console.error('StamPLC flush failed; records retained',String(error).slice(0,160));
      }
      this.nextFlushMs=Date.now()+60000;
    }
    this.emitState();this.planAlarm();
  }
  private async flush(){
    const now=Date.now();
    await this.env.DB.prepare('INSERT INTO devices(id,name,floor,location,status,last_seen) VALUES(?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,last_seen=MAX(devices.last_seen,excluded.last_seen)').bind(this.deviceId,this.deviceId,'',this.device?'online':'offline',Math.floor((this.lastInboundMs||now)/1000)).run();
    for(const row of [...this.ctx.storage.sql.exec('SELECT * FROM stamplc_samples WHERE flushed=0 ORDER BY received_ms LIMIT 100')]){
      await this.env.DB.prepare('INSERT INTO telemetry(ingest_id,device_id,tds,ec,ph,water_temp,esp32_ms,do_ms,ts_ms,utc_ms,date_time_hk,received_ms,relays_json,relay_valid,relay_session) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ingest_id) DO NOTHING').bind(row.ingest_id,row.device_id,row.tds,row.ec,row.ph,row.temp,row.esp32_ms,row.received_ms,row.utc_ms,row.utc_ms,row.date_time_hk,row.received_ms,row.relays_json,row.relay_valid,row.relay_session).run();
      this.ctx.storage.sql.exec('UPDATE stamplc_samples SET flushed=1 WHERE ingest_id=?',row.ingest_id);
    }
    for(const row of [...this.ctx.storage.sql.exec('SELECT * FROM stamplc_commands WHERE flushed=0 LIMIT 100')]){
      await this.env.DB.prepare('INSERT INTO relay_commands(command_id,device_id,session_id,seq,channel,state,issued_ms,expires_ms,status,actor_id,reason,reported_relays_json,relay_valid,acked_utc_ms,updated_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,reported_relays_json=excluded.reported_relays_json,relay_valid=excluded.relay_valid,acked_utc_ms=excluded.acked_utc_ms,updated_ms=excluded.updated_ms').bind(row.command_id,row.device_id,row.session_id,row.seq,row.channel,row.state,row.issued_ms,row.expires_ms,row.status,row.actor_id,row.reason,row.reported_relays_json,row.relay_valid,row.acked_utc_ms,row.updated_ms).run();
      this.ctx.storage.sql.exec('UPDATE stamplc_commands SET flushed=1 WHERE command_id=? AND revision=?',row.command_id,row.revision);
    }
    for(const row of [...this.ctx.storage.sql.exec('SELECT * FROM stamplc_alerts WHERE flushed=0 LIMIT 100')]){
      await this.env.DB.prepare('INSERT INTO alerts(device_id,type,message,severity,created_at,source_id) VALUES(?,?,?,?,?,?) ON CONFLICT(source_id) DO NOTHING').bind(row.device_id,row.type,row.message,row.severity,Math.floor(Number(row.created_ms)/1000),row.id).run();
      this.ctx.storage.sql.exec('UPDATE stamplc_alerts SET flushed=1 WHERE id=?',row.id);
    }
    const rows=await this.env.DB.prepare('SELECT key,value FROM settings WHERE key IN (?,?,?,?,?)').bind('ph_min','ph_max','ec_max','temp_min','temp_max').all<{key:string;value:string}>();
    const map:Record<string,keyof typeof this.thresholds>={ph_min:'phMin',ph_max:'phMax',ec_max:'ecMax',temp_min:'tempMin',temp_max:'tempMax'};
    for(const row of rows.results){const value=Number(row.value);if(Number.isFinite(value))this.thresholds[map[row.key]]=value;}
    const thresholds=JSON.stringify(this.thresholds);
    const saved=[...this.ctx.storage.sql.exec('SELECT value FROM stamplc_meta WHERE key=?','thresholds')][0];
    if(saved?.value!==thresholds)this.ctx.storage.sql.exec('INSERT OR REPLACE INTO stamplc_meta(key,value) VALUES(?,?)','thresholds',thresholds);
    // Retain the newest sample for offline queries after hibernation, even when
    // all history is over a day old. D1 remains the historical record.
    if(this.sample)this.ctx.storage.sql.exec('DELETE FROM stamplc_samples WHERE flushed=1 AND received_ms<? AND received_ms<?',now-86400000,this.sample.received_ms);
  }
  private disconnect(ws:WebSocket){
    if(ws!==this.device)return;this.expirePending('device disconnected',true);this.device=null;this.relayValid=false;this.relaySession=null;this.saveRelay();
    this.markDirty();this.broadcast({type:'device_status',device_id:this.deviceId,status:'offline'});this.emitState();this.planAlarm();
  }
  async webSocketClose(ws:WebSocket){this.disconnect(ws);}
  async webSocketError(ws:WebSocket){this.disconnect(ws);try{ws.close(1011,'WebSocket error');}catch{}}
}

import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {selfQuery} from './protocol.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const PRIVATE=path.join(ROOT,'.greeny2-signal-private.json');
export const RUNTIME=path.join(ROOT,'.signal-runtime');
export function validateConfig(c){if(c?.base_url!=='https://greeny2.openezit.com'||c?.device_id!=='esp32-sensor'||c?.mode!=='note_to_self'||!/^\+[1-9][0-9]{7,14}$/.test(c?.account_number||'')||!/^[0-9a-f]{64}$/.test(c?.bridge_key||''))throw new Error('Invalid private Signal configuration');return c;}
export async function readConfig(){return validateConfig(JSON.parse(await fs.readFile(PRIVATE,'utf8')));}
export async function atomicJSON(file,data){const temp=file+'.'+process.pid+'.'+Math.random().toString(16).slice(2)+'.tmp';await fs.writeFile(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600});await fs.rename(temp,file);}
export async function runtimePaths(){const manifest=JSON.parse(await fs.readFile(path.join(RUNTIME,'runtime.json'),'utf8'));const vendor=path.join(RUNTIME,'vendor');const java=path.join(vendor,manifest.java_root,'bin','java.exe'),classpath=path.join(vendor,'signal-cli-0.14.9','lib','*');if(!manifest.java_root||path.basename(manifest.java_root)!==manifest.java_root)throw new Error('Invalid Java runtime path');await fs.access(java);await fs.access(path.join(vendor,'signal-cli-0.14.9','lib'));return {java,classpath};}
export class SignalRPC {
  constructor(java,classpath,account,onEvent=()=>{},launch=spawn){
    this.next=1;this.pending=new Map();this.closed=false;this.errorTail='';
    const args=['--enable-native-access=ALL-UNNAMED','-Dfile.encoding=UTF-8','-cp',classpath,'org.asamk.signal.Main','--config',path.join(RUNTIME,'account'),'--scrub-log'];if(account)args.push('-a',account);args.push('jsonRpc');
    this.child=launch(java,args,{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.stderr.setEncoding('utf8');this.child.stderr.on('data',text=>{this.errorTail=(this.errorTail+text).slice(-12000);});
    this.lines=createInterface({input:this.child.stdout});
    this.lines.on('line',line=>{if(line.length>1024*1024)return;let value;try{value=JSON.parse(line);}catch{return;}if(value.id!==undefined){const waiter=this.pending.get(String(value.id));if(waiter){this.pending.delete(String(value.id));clearTimeout(waiter.timer);value.error?waiter.reject(new Error('Signal RPC '+String(value.error.code??'error'))):waiter.resolve(value.result);}}else if(value.method==='receive')onEvent(value);});
    const fail=()=>{this.closed=true;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('Signal process stopped'));}this.pending.clear();};this.child.on('error',fail);this.child.on('close',fail);
  }
  call(method,params={},timeout=45000){return new Promise((resolve,reject)=>{if(this.closed)return reject(new Error('Signal process stopped'));const id=String(this.next++);const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Signal RPC timeout'));},timeout);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params,id})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(new Error('Signal RPC write failed'));}});});}
  close(){this.lines.close();this.child.kill();}
}
export class QueryJournal {
  constructor(file){this.db=new DatabaseSync(file);this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS queries(id TEXT PRIMARY KEY, field TEXT NOT NULL, timestamp INTEGER NOT NULL,status TEXT NOT NULL,reply TEXT,updated_ms INTEGER NOT NULL);');this.db.prepare("UPDATE queries SET status='uncertain' WHERE status='sending'").run();}
  claim(query,now=Date.now()){this.db.prepare("INSERT OR IGNORE INTO queries(id,field,timestamp,status,updated_ms) VALUES(?,?,?,'pending',?)").run(query.id,query.field,query.timestamp,now);return this.db.prepare('SELECT * FROM queries WHERE id=?').get(query.id);}
  set(id,status,reply=null){this.db.prepare('UPDATE queries SET status=?,reply=COALESCE(?,reply),updated_ms=? WHERE id=?').run(status,reply,Date.now(),id);}
  resume(now=Date.now()){this.db.prepare('DELETE FROM queries WHERE timestamp<?').run(now-7*86400000);return this.db.prepare("SELECT * FROM queries WHERE status IN ('pending','ready') AND timestamp>=? ORDER BY timestamp").all(now-120000).map(row=>({...row,message:row.field+'?'}));}
  close(){this.db.close();}
}
export async function cloudAnswer(config,query){
  const response=await fetch(config.base_url+'/api/signal/query',{method:'POST',headers:{'Content-Type':'application/json','X-Greeny-Signal-Key':config.bridge_key},body:JSON.stringify({kind:'note_to_self',source_number:config.account_number,message:query.message,timestamp:query.timestamp}),redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('Greeny2 HTTP '+response.status);const body=await response.json();if(body.read_only!==true||typeof body.reply!=='string'||!body.reply||body.reply.length>2000)throw new Error('Invalid Greeny2 reply');return body;
}
export async function handleQuery(query,config,journal,rpc,ask=cloudAnswer){
  const row=journal.claim(query);if(!['pending','ready'].includes(row.status))return {status:'duplicate'};
  let reply=row.reply,cloud=null;
  if(!reply){try{cloud=await ask(config,query);reply=cloud.reply;}catch{reply='Greeny2 暫時未能讀取感測資料，請稍後再輸入 ec?、temp? 或 ph?。';}journal.set(query.id,'ready',reply);}
  journal.set(query.id,'sending');
  try{await rpc.call('send',{noteToSelf:true,message:reply});journal.set(query.id,'sent');return {status:'sent',field:query.field,fresh:cloud?.fresh??null};}catch{journal.set(query.id,'uncertain');return {status:'uncertain',field:query.field};}
}
export async function runBridge(){
  const config=await readConfig(),{java,classpath}=await runtimePaths();await fs.mkdir(RUNTIME,{recursive:true});const lockFile=path.join(RUNTIME,'bridge.lock');let lock;
  try{lock=await fs.open(lockFile,'wx',0o600);await lock.writeFile(String(process.pid));}catch(error){if(error.code!=='EEXIST')throw error;let pid;try{pid=Number(await fs.readFile(lockFile,'utf8'));}catch{}let active=false;if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0);active=true;}catch{}}if(active)throw new Error('A Signal bridge is already running');await fs.unlink(lockFile);return runBridge();}
  const journal=new QueryJournal(path.join(RUNTIME,'bridge.sqlite'));let rpc=null,signalReady=false,stopping=false,queue=Promise.resolve(),lastQuery=null,lastResult=null,attempt=0;
  const statusFile=path.join(RUNTIME,'status.json');const writeStatus=()=>atomicJSON(statusFile,{updated_utc:new Date().toISOString(),pid:process.pid,running:!stopping,signal_process_running:!!rpc&&!rpc.closed,signal_rpc_ready:signalReady,account_mask:'***'+config.account_number.slice(-4),mode:'note_to_self',device_id:config.device_id,last_query:lastQuery,last_result:lastResult}).catch(()=>{});
  const enqueue=query=>{queue=queue.then(async()=>{lastQuery={field:query.field,timestamp:query.timestamp};lastResult=await handleQuery(query,config,journal,rpc);await writeStatus();}).catch(()=>{lastResult={status:'error'};});};
  const stop=async()=>{if(stopping)return;stopping=true;rpc?.close();await queue;await writeStatus();journal.close();await lock.close();await fs.unlink(lockFile).catch(()=>{});};
  process.on('SIGINT',()=>{stop().finally(()=>process.exit(0));});process.on('SIGTERM',()=>{stop().finally(()=>process.exit(0));});
  console.log('Signal bridge started. Use Note to Self: ec? / temp? / ph?.');
  while(!stopping){
    rpc=new SignalRPC(java,classpath,config.account_number,event=>{const query=selfQuery(event,config);if(query)enqueue(query);});
    try{await rpc.call('listDevices',{},60000);signalReady=true;attempt=0;for(const query of journal.resume())enqueue(query);await writeStatus();while(!rpc.closed&&!stopping){await new Promise(resolve=>setTimeout(resolve,5000));await writeStatus();}}catch{lastResult={status:'signal_unavailable'};}finally{signalReady=false;rpc.close();await queue;}
    if(!stopping){attempt++;await writeStatus();await new Promise(resolve=>setTimeout(resolve,Math.min(30000,2000*attempt)));}
  }
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)runBridge().catch(()=>{console.error('Signal bridge could not start. Run setup.mjs status and check runtime/link configuration.');process.exitCode=1;});

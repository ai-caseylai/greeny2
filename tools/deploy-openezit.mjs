import { spawn } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { randomBytes, pbkdf2Sync, createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const EDGE=path.join(ROOT,'edge'), SPA=path.join(ROOT,'spa'), BUILD=path.join(ROOT,'.greeny2-build')
const PRIVATE=path.join(ROOT,'.greeny2-private.json')
const TEMPLATE=path.join(EDGE,'wrangler.openezit.jsonc')
const GENERATED=path.join(BUILD,'wrangler.openezit.generated.json')
const SCHEMA=path.join(EDGE,'db','openezit-schema.sql')
const WRANGLER=path.join(EDGE,'node_modules','wrangler','bin','wrangler.js')
const ACCOUNT='3df8aa5f7718e535dfb690343b98e986', ZONE='3ab61e2584b0f7a86b9d40b153683762'
const HOST='greeny2.openezit.com', DATABASE='greeny2-db', MARKER='openezit:greeny2'
const PLACEHOLDER='00000000-0000-4000-8000-000000000000'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hash=value=>createHash('sha256').update(value).digest('hex')
const say=message=>console.log(message)
const ensure=(ok,message)=>{if(!ok)throw new Error(message)}
const missing=error=>error?.code==='ENOENT'

export function validatePrivate(p){
  ensure(p?.account_id===ACCOUNT&&p?.deployment_marker===MARKER,'Private configuration account or deployment marker does not match this installation.')
  ensure(p?.cloud?.ws_host===HOST&&p?.cloud?.device_id==='esp32-sensor','Private configuration has an unexpected Cloud host or device ID.')
  ensure(/^[0-9a-f]{48}$/i.test(p?.cloud?.device_token||'')&&/^[0-9a-f]{64}$/i.test(p?.jwt_secret||''),'Private configuration credentials have an invalid format.')
  ensure(p?.admin?.username==='admin'&&typeof p.admin.password==='string'&&p.admin.password.length>=24,'Private administrator credentials are missing or invalid.')
  ensure(!p.database_id||(UUID.test(p.database_id)&&p.database_id!==PLACEHOLDER),'Private database ID is invalid.')
  return p
}
export function freshPrivate(){return {cloud:{ws_host:HOST,device_id:'esp32-sensor',device_token:randomBytes(24).toString('hex')},admin:{username:'admin',password:randomBytes(24).toString('base64url')},jwt_secret:randomBytes(32).toString('hex'),account_id:ACCOUNT,deployment_marker:MARKER}}
export function passwordHash(password,salt=randomBytes(16).toString('hex')){
  ensure(/^[0-9a-f]{32}$/i.test(salt),'Invalid password salt.')
  return 'pbkdf2:100000:'+salt+':'+pbkdf2Sync(password,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex')
}
export const sqlString=value=>"'"+String(value).replaceAll("'","''")+"'"
export function bootstrapSql(p){
  validatePrivate(p)
  const values=[['jwt_secret',p.jwt_secret],['device_token',p.cloud.device_token],['ph_min','5.5'],['ph_max','8.5'],['ec_max','2000'],['temp_min','18'],['temp_max','30']]
  return [
    'INSERT INTO offices(id,name,active) VALUES(1,\'Greeny2\',1);',
    'INSERT INTO devices(id,name,floor,location,status,last_seen) VALUES(\'esp32-sensor\',\'M5Stack StamPLC\',1,\'\',\'offline\',0);',
    'INSERT INTO racks(id,name,office_id,device_id,location,status,layer_count) VALUES(1,\'StamPLC\',1,\'esp32-sensor\',\'\',\'active\',1);',
    'INSERT INTO users(id,username,password_hash,role,office_id,display_name,active) VALUES(1,'+sqlString(p.admin.username)+','+sqlString(passwordHash(p.admin.password))+',\'superadmin\',NULL,\'Administrator\',1);',
    ...values.map(([key,value])=>'INSERT INTO settings(key,value) VALUES('+sqlString(key)+','+sqlString(value)+');'),
    'INSERT INTO settings(key,value) VALUES(\'greeny2_deployment_id\','+sqlString(MARKER)+');'
  ].join('\n')+'\n'
}

function childEnvironment(extra={}){
  const env={...process.env,WRANGLER_WRITE_LOGS:'false',WRANGLER_LOG_SANITIZE:'true',WRANGLER_SEND_METRICS:'false',CLOUDFLARE_ACCOUNT_ID:ACCOUNT,NO_COLOR:'1',FORCE_COLOR:'0',...extra}
  delete env.CLOUDFLARE_API_BASE_URL
  delete env.CF_API_BASE_URL
  return env
}
function sanitizedBuildTail(value){
  return value.replace(/\x1b\[[0-9;]*m/g,'').replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi,'$1[redacted]@').replace(/((?:password|pass|device_token|jwt_secret|api_key|access_token|secret)["']?\s*[:=]\s*)(["'])(.*?)\2/gi,'$1$2[redacted]$2').replace(/([?&](?:token|key|secret|password|pass|api_key|access_token|device_token)=)[^&\s"'<>]+/gi,'$1[redacted]').replace(/(authorization\s*[:=]\s*)(?:Bearer\s+)?[^\r\n]+/gi,'$1[redacted]').replace(/((?:password|pass|device_token|jwt_secret|api_key|access_token|secret)["']?\s*[:=]\s*["']?)[^\s"',;}]*/gi,'$1[redacted]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[redacted JWT]').replace(/\b[0-9a-f]{32,}\b/gi,'[redacted hex]').split('\n').slice(-45).join('\n').slice(-6000)
}
async function runNode(script,args,{cwd=ROOT,label='Command',timeoutMs=180000,extraEnv={},safeDiagnostic=false}={}){
  await fs.access(script)
  return await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,...args],{cwd,env:childEnvironment(extraEnv),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let stdout='',stderr='',done=false,tooLarge=false
    const timer=setTimeout(()=>{child.kill();},timeoutMs)
    const collect=which=>chunk=>{if(stdout.length+stderr.length>16*1024*1024){tooLarge=true;child.kill();return}if(which==='out')stdout+=chunk.toString('utf8');else stderr+=chunk.toString('utf8')}
    child.stdout.on('data',collect('out'));child.stderr.on('data',collect('err'))
    child.on('error',()=>{if(done)return;done=true;clearTimeout(timer);reject(new Error(label+' could not start. Check installed Node/npm dependencies.'))})
    child.on('close',code=>{if(done)return;done=true;clearTimeout(timer);if(code===0&&!tooLarge)resolve({stdout,stderr});else reject(new Error(label+' failed'+(Number.isInteger(code)?' (exit '+code+')':' or timed out')+(safeDiagnostic?'\n'+sanitizedBuildTail(stdout+'\n'+stderr):'. Raw child output was withheld because it may contain private configuration.')))})
  })
}
function parseJsonOutput(text){
  const cleaned=text.replace(/\x1b\[[0-9;]*m/g,'').trim()
  try{return JSON.parse(cleaned)}catch{}
  for(let i=0;i<cleaned.length;i++)if((i===0||cleaned[i-1]==='\n')&&(cleaned[i]==='['||cleaned[i]==='{')){try{return JSON.parse(cleaned.slice(i))}catch{}}
  throw new Error('Cloudflare returned an unexpected JSON response. No private response data was printed.')
}
async function wrangler(args,label,timeoutMs,safeDiagnostic=false){return runNode(WRANGLER,[...args,'--config',GENERATED],{cwd:EDGE,label,timeoutMs,safeDiagnostic})}
async function wranglerJson(args,label){return parseJsonOutput((await wrangler([...args,'--json'],label)).stdout)}
async function npmCli(){
  const paths=[process.env.GREENY_NPM_CLI,path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'),path.join(process.env.ProgramFiles||'C:/Program Files','nodejs','node_modules','npm','bin','npm-cli.js')].filter(Boolean)
  for(const candidate of paths){try{await fs.access(candidate);return candidate}catch{}}
  throw new Error('npm-cli.js was not found. Install Node.js/npm, or set GREENY_NPM_CLI to its absolute JavaScript path.')
}
async function template(){
  const text=await fs.readFile(TEMPLATE,'utf8')
  const c=JSON.parse(text.replace(/^\s*\/\/.*$/mg,''))
  ensure(c.account_id===ACCOUNT&&c.name==='greeny2','Deployment template account/name mismatch.')
  ensure(c.routes?.length===1&&c.routes[0].pattern===HOST&&c.routes[0].custom_domain===true&&c.routes[0].zone_id===ZONE,'Deployment template route mismatch.')
  ensure(c.d1_databases?.length===1&&c.d1_databases[0].binding==='DB'&&c.d1_databases[0].database_name===DATABASE,'Deployment template database mismatch.')
  ensure(c.main==='src/index.ts'&&c.assets?.directory==='../spa/dist'&&c.assets?.binding==='ASSETS','Deployment template entry/assets mismatch.')
  return c
}
async function writeConfig(databaseId=PLACEHOLDER){
  ensure(UUID.test(databaseId),'Cannot generate a config with an invalid database UUID.')
  const c=await template()
  c.$schema=path.join(EDGE,'node_modules','wrangler','config-schema.json')
  c.main=path.join(EDGE,'src','index.ts')
  c.assets.directory=path.join(SPA,'dist')
  c.d1_databases[0].database_id=databaseId
  await fs.writeFile(GENERATED,JSON.stringify(c,null,2)+'\n',{mode:0o600})
}
async function readPrivate(){
  try{return validatePrivate(JSON.parse(await fs.readFile(PRIVATE,'utf8')))}catch(error){if(missing(error))return null;throw new Error('The existing .greeny2-private.json is unreadable or invalid. Preserve it and recover its original values; this helper will not reset credentials.')}
}
async function createOrReadPrivate(){
  const existing=await readPrivate();if(existing)return existing
  const p=freshPrivate(),handle=await fs.open(PRIVATE,'wx',0o600)
  try{await handle.writeFile(JSON.stringify(p,null,2)+'\n');await handle.sync()}finally{await handle.close()}
  say('Created .greeny2-private.json. Keep this local file for administrator login and device provisioning; its values will not be printed.')
  return p
}
async function saveDatabaseId(p,id){
  ensure(UUID.test(id)&&id!==PLACEHOLDER,'Invalid database ID.')
  const current=await readPrivate();ensure(current&&current.jwt_secret===p.jwt_secret&&current.cloud.device_token===p.cloud.device_token,'Private configuration changed during deployment. Stopping without replacing it.')
  if(current.database_id){ensure(current.database_id===id,'The saved database ID differs from the selected own-account database.');return current}
  const next={...current,database_id:id},temp=PRIVATE+'.'+randomBytes(6).toString('hex')+'.tmp'
  try{await fs.writeFile(temp,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(temp,PRIVATE)}finally{await fs.unlink(temp).catch(()=>{})}
  return next
}
async function requireOwnAccount(){
  const info=await wranglerJson(['whoami'],'Cloudflare authentication check')
  ensure(info.loggedIn===true&&Array.isArray(info.accounts)&&info.accounts.some(a=>a.id===ACCOUNT),'Authenticate the intended Cloudflare account first: run this helper with login. No remote resource has been changed.')
  say('Verified the intended Cloudflare account.')
}
async function login(){
  let authenticated=false
  try{await requireOwnAccount();authenticated=true}catch{}
  if(!authenticated){say('Opening Cloudflare OAuth login in your browser. Approve the intended account, then return here.');await wrangler(['login'],'Cloudflare browser login',240000);await requireOwnAccount()}
}
async function sourceHashes(){
  const files=[]
  async function collect(relative){const absolute=path.join(ROOT,relative);let stat;try{stat=await fs.stat(absolute)}catch(error){if(missing(error))return;throw error}if(stat.isDirectory()){for(const name of (await fs.readdir(absolute)).sort())await collect(path.join(relative,name))}else if(stat.isFile())files.push(relative)}
  for(const relative of ['edge/src','edge/db/openezit-schema.sql','edge/package.json','edge/package-lock.json','edge/wrangler.openezit.jsonc','spa/src','spa/functions','spa/public','spa/index.html','spa/package.json','spa/package-lock.json','spa/vite.config.ts','spa/tsconfig.json','spa/tsconfig.app.json','spa/tsconfig.node.json','tools/deploy-openezit.mjs'])await collect(relative)
  const result={};for(const relative of files.sort())result[relative.replaceAll('\\','/')]=hash(await fs.readFile(path.join(ROOT,relative)))
  return result
}
async function build(){
  await fs.access(SCHEMA)
  const before=await sourceHashes()
  await writeConfig()
  say('Building the SPA with the same-origin production API.')
  await runNode(await npmCli(),['run','build'],{cwd:SPA,label:'SPA build',timeoutMs:300000,extraEnv:{VITE_API_BASE_URL:''},safeDiagnostic:true})
  say('Checking the Worker and static assets with a deployment dry run.')
  await wrangler(['deploy','--dry-run','--outdir',path.join(BUILD,'worker')],'Worker dry run',300000,true)
  const after=await sourceHashes()
  ensure(JSON.stringify(before)===JSON.stringify(after),'Source files changed during the build. Rerun build before deploying.')
  const manifest={created_utc:new Date().toISOString(),source_sha256:after,origin:'https://'+HOST,account_id:ACCOUNT}
  await fs.writeFile(path.join(BUILD,'build-manifest.json'),JSON.stringify(manifest,null,2)+'\n')
  say('SPA build and Worker dry run succeeded. Review .greeny2-build/build-manifest.json.')
  return manifest
}
function resultRows(value){
  ensure(Array.isArray(value),'Unexpected D1 result envelope.')
  ensure(value.every(v=>v?.success!==false),'D1 rejected a query.')
  return value.flatMap(v=>Array.isArray(v.results)?v.results:[])
}
async function query(sql){return resultRows(await wranglerJson(['d1','execute','DB','--remote','--command',sql,'--yes'],'D1 read-only verification'))}
async function listDatabases(){const result=await wranglerJson(['d1','list'],'Own-account database list');ensure(Array.isArray(result),'Unexpected D1 database list.');return result}
async function selectDatabase(p){
  let list=await listDatabases(),matches=list.filter(db=>db.name===DATABASE)
  ensure(matches.length<=1,'Multiple databases have the expected own-account name.')
  if(p.database_id){ensure(matches.length===1&&matches[0].uuid===p.database_id,'The saved database ID does not match this own-account database.');return p}
  if(matches.length===0){say('Creating the new own-account greeny2-db database.');await wrangler(['d1','create',DATABASE,'--location','apac','--update-config','false'],'Own-account D1 creation');list=await listDatabases();matches=list.filter(db=>db.name===DATABASE)}
  ensure(matches.length===1&&UUID.test(matches[0].uuid),'The own-account database could not be identified safely.')
  return saveDatabaseId(p,matches[0].uuid)
}
async function withSqlFile(sql,operation){
  const file=path.join(BUILD,'bootstrap-'+randomBytes(8).toString('hex')+'.private.sql')
  try{await fs.writeFile(file,sql,{flag:'wx',mode:0o600});return await operation(file)}finally{await fs.unlink(file).catch(()=>{})}
}
async function verifyInstalled(p){
  const settings=await query("SELECT key,value FROM settings WHERE key IN ('greeny2_deployment_id','jwt_secret','device_token');")
  const values=Object.fromEntries(settings.map(r=>[r.key,r.value]))
  ensure(values.greeny2_deployment_id===MARKER,'Database deployment marker does not match. Nothing will be reset.')
  ensure(values.jwt_secret===p.jwt_secret&&values.device_token===p.cloud.device_token,'Database secrets differ from the preserved private file. Nothing will be reset.')
  const required={telemetry:['ingest_id','utc_ms','date_time_hk','received_ms','relays_json','relay_valid','relay_session','tds'],relay_commands:['command_id','device_id','session_id','seq','channel','state','issued_ms','expires_ms','status','reported_relays_json','relay_valid','acked_utc_ms','updated_ms'],alerts:['source_id']}
  for(const [table,columns] of Object.entries(required)){const info=await query('PRAGMA table_info('+table+');');ensure(columns.every(name=>info.some(column=>column.name===name)),'The own-account database schema is incomplete. Nothing will be reset.');if(table==='telemetry')ensure(Number(info.find(column=>column.name==='tds')?.notnull)===0,'The own-account TDS column must accept NULL for an unmeasured sensor.')}
  const admin=await query("SELECT username,role,active FROM users WHERE username='admin';")
  ensure(admin.length===1&&admin[0].role==='superadmin'&&Number(admin[0].active)===1,'Expected active administrator was not found. Nothing will be reset.')
  const mapping=await query("SELECT d.id FROM devices d JOIN racks r ON r.device_id=d.id JOIN offices o ON o.id=r.office_id WHERE d.id='esp32-sensor' AND r.id=1 AND o.id=1;")
  ensure(mapping.length===1,'Expected office/rack/device mapping was not found. Nothing will be reset.')
}
async function initializeDatabase(p){
  const tables=await query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB 'd1_*' ORDER BY name;")
  const names=tables.map(t=>t.name)
  let marker=null
  if(names.includes('settings'))marker=(await query("SELECT value FROM settings WHERE key='greeny2_deployment_id';"))[0]?.value??null
  if(marker!==null){ensure(marker===MARKER,'This database belongs to a different installation. Initialization was refused.');await verifyInstalled(p);say('Existing own-account initialization verified; secrets and administrator password were preserved.');return}
  for(const name of names){ensure(typeof name==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(name),'Unexpected pre-existing database table; initialization refused.');const rows=await query('SELECT COUNT(*) AS n FROM "'+name+'";');ensure(Number(rows[0]?.n)===0,'An unmarked database contains existing data. Initialization was refused without changing it.')}
  const sql=await fs.readFile(SCHEMA,'utf8')
  ensure(!/\b(?:BEGIN(?:\s+TRANSACTION)?|COMMIT)\s*;/i.test(sql),'The fresh schema must not contain explicit transaction statements; D1 import supplies atomicity.')
  say('Initializing the empty own-account database. Private SQL output is suppressed.')
  await withSqlFile(sql+'\n'+bootstrapSql(p),file=>wrangler(['d1','execute','DB','--remote','--file',file,'--yes','--json'],'Fresh D1 schema/bootstrap import',300000))
  await verifyInstalled(p)
}
export function healthMatches(body){return body?.status==='ok'&&body?.service==='greeny2-openezit'&&body?.protocol===2&&body?.schema_version===2&&body?.deployment_marker===MARKER}
export async function publicDnsHealth(){
  try{
    const response=await fetch('https://cloudflare-dns.com/dns-query?name='+HOST+'&type=A',{headers:{accept:'application/dns-json'},signal:AbortSignal.timeout(10000),redirect:'error'})
    if(!response.ok)return false
    const dns=await response.json()
    if(dns.Status!==0||!Array.isArray(dns.Answer))return false
    const answer=dns.Answer.find(a=>a.type===1&&String(a.name).replace(/\.$/,'').toLowerCase()===HOST&&isIP(a.data)===4)
    if(!answer)return false
    return await new Promise(resolve=>{
      const req=httpsRequest({hostname:HOST,servername:HOST,port:443,path:'/health',method:'GET',rejectUnauthorized:true,headers:{accept:'application/json'},timeout:10000,lookup:(_host,options,callback)=>options.all?callback(null,[{address:answer.data,family:4}]):callback(null,answer.data,4)},res=>{
        let text='',tooLarge=false
        res.on('data',b=>{text+=b;if(Buffer.byteLength(text)>8192){tooLarge=true;req.destroy();resolve(false)}})
        res.on('error',()=>resolve(false))
        res.on('end',()=>{try{resolve(!tooLarge&&res.statusCode===200&&healthMatches(JSON.parse(text)))}catch{resolve(false)}})
      })
      req.on('error',()=>resolve(false));req.on('timeout',()=>{req.destroy();resolve(false)});req.end()
    })
  }catch{return false}
}

async function healthCheck(){
  for(let attempt=0;attempt<8;attempt++){
    try{const response=await fetch('https://'+HOST+'/health',{signal:AbortSignal.timeout(10000),redirect:'error',headers:{accept:'application/json'}});const body=await response.json();if(response.ok&&healthMatches(body))return}catch{}
    if(attempt<7)await new Promise(resolve=>setTimeout(resolve,3000))
  }
  if(await publicDnsHealth()){say('Public DNS and certificate-verified HTTPS health passed. This computer DNS has not updated; no local network settings were changed.');return}
  throw new Error('Deployment completed, but the own HTTPS /health JSON check did not succeed. Check Cloudflare custom-domain/DNS activation; do not reset credentials.')
}
async function deploy(){
  const manifest=await build()
  await requireOwnAccount()
  let p=await createOrReadPrivate()
  p=await selectDatabase(p)
  await writeConfig(p.database_id)
  await initializeDatabase(p)
  ensure(JSON.stringify(manifest.source_sha256)===JSON.stringify(await sourceHashes()),'Source changed after validation. Rerun deploy before publishing.')
  say('Deploying the validated Worker and SPA to https://'+HOST+'/ .')
  await wrangler(['deploy'],'Own-account Worker/SPA deployment',300000)
  await healthCheck()
  say('HTTPS health check passed: https://'+HOST+'/ .')
  say('Administrator credentials and the firmware device token remain in .greeny2-private.json; their values were not printed.')
}
export async function main(stage){
  ensure(['build','login','deploy'].includes(stage),'Usage: node tools/deploy-openezit.mjs build|login|deploy')
  await fs.mkdir(BUILD,{recursive:true})
  const lock=path.join(BUILD,'deployment.lock');let handle
  try{handle=await fs.open(lock,'wx',0o600)}catch(error){if(error.code==='EEXIST')throw new Error('Another helper run may be active. Check .greeny2-build/deployment.lock before removing a stale lock.');throw error}
  try{await handle.writeFile(String(process.pid));await writeConfig();if(stage==='build')await build();else if(stage==='login')await login();else await deploy()}
  finally{await handle.close();await fs.unlink(lock).catch(()=>{})}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){main(process.argv[2]).catch(error=>{console.error(error instanceof Error?error.message:'Deployment helper failed.');process.exitCode=1})}

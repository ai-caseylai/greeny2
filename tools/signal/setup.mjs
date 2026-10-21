import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {SignalRPC,PRIVATE,RUNTIME,readConfig,validateConfig,atomicJSON,runtimePaths,cloudAnswer} from './bridge.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const ensure=(value,message)=>{if(!value)throw new Error(message);};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function exec(file,args,{inherit=false,env=process.env,timeout=180000}={}){return new Promise((resolve,reject)=>{const child=spawn(file,args,{cwd:ROOT,env,shell:false,windowsHide:!inherit,stdio:inherit?'inherit':['ignore','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>child.kill(),timeout);if(!inherit){child.stdout.on('data',chunk=>{out+=chunk;if(out.length>8*1024*1024)child.kill();});child.stderr.on('data',chunk=>{err+=chunk;});}child.on('error',()=>{clearTimeout(timer);reject(new Error('Cannot start '+path.basename(file)));});child.on('close',code=>{clearTimeout(timer);code===0?resolve(out):reject(new Error(path.basename(file)+' failed (exit '+code+'). Private command output was withheld.'));});});}
const psScript=(script,env={})=>exec(path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,...env}});
async function download(asset,directory){
  ensure(/^https:\/\/github\.com\/(AsamK\/signal-cli|adoptium\/temurin25-binaries)\/releases\/download\//.test(asset.url)&&/^[0-9a-f]{64}$/.test(asset.sha256),'Invalid pinned runtime download');
  const file=path.join(directory,asset.file);let existing;try{existing=await fs.readFile(file);}catch{}
  if(existing&&createHash('sha256').update(existing).digest('hex')===asset.sha256)return file;
  console.log('Downloading verified runtime: '+asset.file);
  const response=await fetch(asset.url,{signal:AbortSignal.timeout(600000)});ensure(response.ok,'Runtime download failed: HTTP '+response.status);const bytes=Buffer.from(await response.arrayBuffer());
  ensure(createHash('sha256').update(bytes).digest('hex')===asset.sha256,'Runtime SHA-256 mismatch; archive was not extracted');await fs.writeFile(file,bytes);return file;
}

export function archiveRoot(text){
  const listing=text.trim().split(/\r?\n/).filter(Boolean).map(name=>name.replace(/^(?:\.\/)+/,'')).filter(name=>name&&name!=='.');
  ensure(listing.length>0&&listing.every(name=>!name.startsWith('/')&&!name.includes('\\')&&!name.includes(':')&&!name.split('/').includes('..')),'Unsafe runtime archive paths');
  const roots=[...new Set(listing.map(name=>name.split('/')[0]))];
  ensure(roots.length===1&&/^[A-Za-z0-9_.+-]+$/.test(roots[0])&&roots[0]!=='.','Unexpected runtime archive root');
  return roots[0];
}

async function installRuntime(){
  ensure(process.platform==='win32'&&process.arch==='x64','This installer supports Windows x64.');ensure(Number(process.versions.node.split('.')[0])>=24,'Node.js 24+ is required.');
  await fs.mkdir(path.join(RUNTIME,'vendor'),{recursive:true});await fs.mkdir(path.join(RUNTIME,'downloads'),{recursive:true});await fs.mkdir(path.join(RUNTIME,'account'),{recursive:true});
  const lock=JSON.parse(await fs.readFile(path.join(ROOT,'tools/signal/runtime-lock.json'),'utf8'));let javaRoot=null;
  const tar=path.join(process.env.SystemRoot||'C:/Windows','System32/tar.exe');
  for(const asset of [lock.java,lock.signal]){
    const archive=await download(asset,path.join(RUNTIME,'downloads'));
    const root=archiveRoot(await exec(tar,['-tf',archive]));
    if(asset===lock.signal)ensure(root===lock.signal.root,'Unexpected Signal archive version');else javaRoot=root;
    console.log('Extracting '+asset.file+' (SHA-256 verified).');await exec(tar,['-xf',archive,'-C',path.join(RUNTIME,'vendor')],{timeout:180000});
  }
  await atomicJSON(path.join(RUNTIME,'runtime.json'),{signal_version:lock.signal.version,java_root:javaRoot,installed_utc:new Date().toISOString()});const {java,classpath}=await runtimePaths();await exec(java,['-version']);const version=await exec(java,['--enable-native-access=ALL-UNNAMED','-Dfile.encoding=UTF-8','-cp',classpath,'org.asamk.signal.Main','--version']);ensure(version.includes('0.14.9'),'Unexpected Signal runtime version');console.log('Signal 0.14.9 and Java runtimes verified and ready.');
}
async function provision(account){
  ensure(/^\+[1-9][0-9]{7,14}$/.test(account||''),'Supply the phone number in E.164 format.');let c;try{c=await readConfig();ensure(c.account_number===account,'Existing Signal configuration uses another account; it was preserved.');}catch(error){if(error.code!=='ENOENT')throw error;c={base_url:'https://greeny2.openezit.com',device_id:'esp32-sensor',mode:'note_to_self',account_number:account,bridge_key:randomBytes(32).toString('hex')};validateConfig(c);await atomicJSON(PRIVATE,c);}
  const credentials=JSON.parse(await fs.readFile(path.join(ROOT,'.greeny2-private.json'),'utf8'));ensure(credentials.account_id==='3df8aa5f7718e535dfb690343b98e986'&&credentials.deployment_marker==='openezit:greeny2','Wrong Greeny2 Cloud configuration');
  const login=await fetch(c.base_url+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials.admin),redirect:'error',signal:AbortSignal.timeout(20000)});ensure(login.ok,'Administrator login failed; existing credentials were preserved');const auth=await login.json();ensure(typeof auth.token==='string','Invalid login response');
  const response=await fetch(c.base_url+'/api/signal/config',{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth.token},body:JSON.stringify({enabled:true,mode:c.mode,account_number:c.account_number,device_id:c.device_id,bridge_key:c.bridge_key}),redirect:'error',signal:AbortSignal.timeout(20000)});ensure(response.ok,'Signal Cloud configuration failed (HTTP '+response.status+'); deploy the updated Worker first.');
  const check=await cloudAnswer(c,{message:'ec?',timestamp:Date.now()});console.log('Signal Cloud query verified; sensor '+(check.fresh?'live':'offline/stale')+'. Credentials remain private.');
}
async function accounts(){const {java,classpath}=await runtimePaths();const rpc=new SignalRPC(java,classpath,null);try{return await rpc.call('listAccounts',{},60000);}finally{rpc.close();}}
async function linkTerminal(){
  const c=await readConfig(),existing=await accounts();ensure(Array.isArray(existing),'Invalid linked account response');let account=existing.find(item=>item.number===c.account_number);
  if(!account){ensure(existing.length===0,'Another account is already linked in this private directory; it was preserved.');const {java,classpath}=await runtimePaths();console.log('Open Signal on the customer phone: profile > Linked devices > Link a new device. Scan the QR code below. Keep this PowerShell window open.');await exec(java,['--enable-native-access=ALL-UNNAMED','-Dfile.encoding=UTF-8','-cp',classpath,'org.asamk.signal.Main','--config',path.join(RUNTIME,'account'),'--scrub-log','link','--name','Greeny2 Note to Self'],{inherit:true,timeout:180000});account=(await accounts()).find(item=>item.number===c.account_number);}
  ensure(account,'The paired phone number does not match the selected account; no message service was started.');c.account_aci=account.aci??account.uuid??null;await atomicJSON(PRIVATE,c);console.log('LINKED: customer phone account verified; no primary account was re-registered.');
}

async function link(){await (await import('./pair.mjs')).pairPhone();}

const psLiteral=value=>"'"+value.replaceAll("'","''")+"'";
async function start(autostart=true){
  await readConfig();await runtimePaths();
  const runner=path.join(ROOT,'tools/signal/bridge.mjs'),startFile=path.join(RUNTIME,'start-bridge.ps1');
  const script='$ErrorActionPreference = "Stop"\nStart-Process -FilePath '+psLiteral(process.execPath)+' -ArgumentList '+psLiteral('"'+runner+'"')+' -WindowStyle Hidden -RedirectStandardOutput '+psLiteral(path.join(RUNTIME,'bridge.stdout.log'))+' -RedirectStandardError '+psLiteral(path.join(RUNTIME,'bridge.stderr.log'))+'\n';
  await fs.writeFile(startFile,script,'utf8');
  if(autostart){
    const registration='$ErrorActionPreference="Stop"; $shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath("Startup")) "Greeny2 Signal.lnk")); $shortcut.TargetPath=$env:GREENY_SIGNAL_POWERSHELL; $shortcut.Arguments=$env:GREENY_SIGNAL_ARGUMENTS; $shortcut.WorkingDirectory=$env:GREENY_SIGNAL_ROOT; $shortcut.WindowStyle=7; $shortcut.Save()';
    await psScript(registration,{GREENY_SIGNAL_POWERSHELL:path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),GREENY_SIGNAL_ARGUMENTS:'-NoProfile -WindowStyle Hidden -File "'+startFile+'"',GREENY_SIGNAL_ROOT:ROOT});console.log('Autostart installed for the current Windows user login.');
  }
  try{const old=JSON.parse(await fs.readFile(path.join(RUNTIME,'status.json'),'utf8'));if(old.running&&Date.now()-Date.parse(old.updated_utc)<20000){console.log('Signal bridge already running.');return;}}catch{}
  await psScript(script);
  for(let attempt=0;attempt<12;attempt++){await sleep(1000);try{const state=JSON.parse(await fs.readFile(path.join(RUNTIME,'status.json'),'utf8'));if(state.running&&state.signal_rpc_ready&&Date.now()-Date.parse(state.updated_utc)<10000){console.log('READY: Signal bridge is running. In the phone Note to Self send ec?, temp?, ph?.');return;}}catch{}}
  throw new Error('Bridge startup not confirmed. Run: node tools/signal/setup.mjs status');
}
async function status(){
  const c=await readConfig();let state=null;try{state=JSON.parse(await fs.readFile(path.join(RUNTIME,'status.json'),'utf8'));}catch{}
  let cloud=null;try{const result=await cloudAnswer(c,{message:'ec?',timestamp:Date.now()});cloud={ok:true,sensor_connected:result.connected,sensor_fresh:result.fresh,sample_time_hk:result.sample_time_hk};}catch{cloud={ok:false};}
  const recent=!!state&&Date.now()-Date.parse(state.updated_utc)<20000;console.log(JSON.stringify({account_mask:'***'+c.account_number.slice(-4),mode:c.mode,bridge:state?{...state,running:state.running&&recent}:null,cloud},null,2));
}
async function stop(){
  const runner=path.join(ROOT,'tools/signal/bridge.mjs');const script='$ErrorActionPreference="Stop"; Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:GREENY_SIGNAL_RUNNER) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Stop }; $shortcut=Join-Path ([Environment]::GetFolderPath("Startup")) "Greeny2 Signal.lnk"; if(Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }';await psScript(script,{GREENY_SIGNAL_RUNNER:runner});console.log('Signal bridge stopped; its own login shortcut removed. Phone pairing and private configuration preserved.');
}
export async function main(stage,account){
  if(stage==='all'){await installRuntime();await provision(account);await link();await start();}
  else if(stage==='runtime')await installRuntime();
  else if(stage==='provision')await provision(account);
  else if(stage==='link'){await link();await start();}
  else if(stage==='link-terminal'){await linkTerminal();await start();}
  else if(stage==='start')await start();
  else if(stage==='status')await status();
  else if(stage==='stop')await stop();
  else throw new Error('Usage: node tools/signal/setup.mjs all|runtime|provision|link|start|status|stop [account-number]');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv[2],process.argv[3]).catch(error=>{console.error('FAILED: '+(error instanceof Error?error.message:'Signal setup failed'));process.exitCode=1;});

import http from 'node:http';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import qrcode from './vendor/qrcode.cjs';
import {SignalRPC,RUNTIME,readConfig,runtimePaths,atomicJSON} from './bridge.mjs';
export function linkURI(value){
  if(typeof value!=='string'||value.length>2000)throw new Error('Invalid Signal link URI');
  let url;try{url=new URL(value);}catch{throw new Error('Invalid Signal link URI');}
  if(url.protocol!=='sgnl:'||url.hostname!=='linkdevice'||url.username||url.password||!url.searchParams.get('uuid')||!url.searchParams.get('pub_key'))throw new Error('Invalid Signal link URI');
  return value;
}
export function qrSVG(value){
  linkURI(value);const code=qrcode(0,'M');code.addData(value,'Byte');code.make();const count=code.getModuleCount(),size=count+8;let cells='';
  for(let row=0;row<count;row++)for(let col=0;col<count;col++)if(code.isDark(row,col))cells+='M'+(col+4)+' '+(row+4)+'h1v1h-1z';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+size+' '+size+'" width="440" height="440" role="img" aria-label="Signal 配對 QR code" shape-rendering="crispEdges"><rect width="'+size+'" height="'+size+'" fill="#fff"/><path d="'+cells+'" fill="#000"/></svg>';
}
export function pairPage(nonce){return [
'<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Greeny2 · Signal 配對</title>',
'<style nonce="'+nonce+'">body{margin:0;background:#f0f4f2;color:#18372b;font:18px system-ui,sans-serif}main{max-width:700px;margin:24px auto;padding:24px;background:white;border-radius:16px;text-align:center}h1{font-size:28px}p{line-height:1.6}button{background:#176b45;color:white;border:0;border-radius:8px;padding:14px 20px;font-size:20px;cursor:pointer}button:disabled{opacity:.55;cursor:wait}#qr{background:white;margin:20px auto;min-height:50px}#qr svg{width:min(440px,85vw);height:auto;display:block;margin:auto}#state{font-weight:bold;min-height:32px}.ok{color:#087f38}.error{color:#b42318}.small{font-size:15px;color:#567}ol{text-align:left;line-height:1.8;display:inline-block;padding-left:25px}</style></head><body><main>',
'<h1>Greeny2 · Signal 配對</h1><ol><li>先在手機開啟 Signal：頭像 → 已連結裝置 → 連結新裝置。</li><li>手機掃碼畫面準備好後，按下方按鈕產生新碼。</li><li>立即掃描，並在手機確認連結「Greeny2 Note to Self」。</li></ol>',
'<p id="state">準備好手機後，請產生新碼。</p><button id="start">產生新的配對碼</button><div id="qr"></div><p id="detail"></p><p class="small">若掃描無反應，可按按鈕重新產生。請保持 PowerShell 視窗開啟。</p></main>',
'<script nonce="'+nonce+'">const base=location.pathname.replace(/\\/$/,""),button=document.getElementById("start"),state=document.getElementById("state"),detail=document.getElementById("detail"),qr=document.getElementById("qr");let linked=false,lastSVG="";async function poll(){try{const r=await fetch(base+"/state",{cache:"no-store"});const s=await r.json();state.className=s.phase==="linked"?"ok":s.phase==="failed"?"error":"";state.textContent=s.phase==="idle"?"準備好手機後，請產生新碼。":s.phase==="preparing"?"正在向 Signal 取得新碼…":s.phase==="waiting"?"請立即用手機 Signal 掃描下方新碼。":s.phase==="linked"?"配對成功，正在啟動 Greeny2 背景服務。":"此碼未完成配對，請重新產生。";detail.textContent=s.detail||"";if(s.svg&&s.svg!==lastSVG){qr.innerHTML=s.svg;lastSVG=s.svg;}if(!s.svg){qr.textContent="";lastSVG="";}button.disabled=s.phase==="preparing"||s.phase==="linked";button.textContent=s.phase==="waiting"?"重新產生配對碼":"產生新的配對碼";if(s.phase==="linked"){linked=true;clearInterval(timer);}}catch{if(!linked){state.className="error";state.textContent="配對程序已結束。請在 PowerShell 重新執行 link 命令。";button.disabled=true;qr.textContent="";}}}button.onclick=async()=>{button.disabled=true;state.textContent="正在準備新碼…";try{await fetch(base+"/start",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});await poll();}catch{await poll();}};const timer=setInterval(poll,1000);poll();</script></body></html>'
].join('\n');}
export function localRequest(request,origin,base){
  if(request.headers.host!==new URL(origin).host)return false;
  const route=request.url;if(![base+'/',base+'/state',base+'/start'].includes(route))return false;
  if(request.method==='POST')return route===base+'/start'&&request.headers.origin===origin&&request.headers['content-type']==='application/json';
  return request.method==='GET'&&(route===base+'/'||route===base+'/state');
}
export async function pairPhone({makeRPC,writeState=atomicJSON,render=qrSVG,onListening}={}){
  const config=await readConfig(),runtime=await runtimePaths(),nonce=randomBytes(24).toString('hex'),base='/pair/'+nonce;let origin='',rpc=null,attempt=0,finished=false;
  let state={phase:'idle',detail:'',svg:null};let resolveDone,rejectDone;const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
  const savedState=()=>({phase:state.phase,detail:state.detail,pair_url:origin+base+'/',pid:process.pid,updated_utc:new Date().toISOString(),attempt});
  const update=async(value)=>{state=value;await writeState(path.join(RUNTIME,'pair-session.json'),savedState());};
  const complete=async(account)=>{if(account?.number!==config.account_number)throw new Error('The paired account does not match the configured phone');config.account_aci=account.aci??account.uuid??null;await writeState(path.join(path.dirname(RUNTIME),'.greeny2-signal-private.json'),config);await update({phase:'linked',detail:'手機帳戶已核對。回到 PowerShell 等待 READY，然後在個人筆記輸入 ec?、temp?、ph?。',svg:null});console.log('LINKED: customer phone account verified.');finished=true;setTimeout(resolveDone,2500);};
  const generate=async()=>{
    if(finished)return;const current=++attempt;rpc?.close();await update({phase:'preparing',detail:'正在建立新的 Signal 配對工作階段。',svg:null});
    let client;
    try{
      client=makeRPC?makeRPC():new SignalRPC(runtime.java,runtime.classpath,null);rpc=client;
      const accounts=await client.call('listAccounts',{},45000);if(current!==attempt)return;
      if(!Array.isArray(accounts))throw new Error('Invalid Signal account response');const existing=accounts.find(account=>account.number===config.account_number);
      if(existing){await complete(existing);return;}if(accounts.length)throw new Error('A different Signal account is already linked');
      const pending=await client.call('startLink',{},45000);if(current!==attempt)return;const uri=linkURI(pending?.deviceLinkUri);
      await update({phase:'waiting',detail:'只掃描目前這個新碼。若失效或沒有反應，按「重新產生配對碼」。',svg:render(uri)});
      const result=await client.call('finishLink',{deviceLinkUri:uri,deviceName:'Greeny2 Note to Self'},150000);if(current!==attempt)return;
      const linked=(await client.call('listAccounts',{},45000)).find(account=>account.number===config.account_number);if(current!==attempt)return;await complete(linked??result);
    }catch(error){if(current===attempt&&!finished){await update({phase:'failed',detail:/429/.test(error.message)?'Signal 暫時限制配對次數，請稍後再試。':'配對未完成，請準備好手機後重新產生。'+(error.message==='Signal RPC timeout'?'（等待逾時）':''),svg:null});console.log('PAIRING: attempt did not complete; use the browser button to generate a new code.');}}
    finally{if(client&&(!finished||current!==attempt))client.close();}
  };
  const server=http.createServer((request,response)=>{
    if(!localRequest(request,origin,base)){response.writeHead(404);response.end('Not found');return;}
    const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'};
    if(request.method==='POST'){
      request.resume();if(finished){response.writeHead(409,headers);response.end();return;}
      response.writeHead(202,{...headers,'Content-Type':'application/json'});response.end('{"accepted":true}');generate().catch(()=>{});return;
    }
    if(request.url===base+'/state'){response.writeHead(200,{...headers,'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(state));return;}
    response.writeHead(200,{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'nonce-"+nonce+"'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});response.end(pairPage(nonce));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;await update(state);
  console.log('PAIR PAGE: '+origin+base+'/');console.log('Open this address on this computer. Prepare the phone Signal linked-device scanner, then click the button to create a fresh code.');if(onListening)onListening(origin+base+'/');
  const timer=setTimeout(()=>rejectDone(new Error('Pairing page timed out; run link again')),15*60000);
  try{await done;}finally{clearTimeout(timer);attempt++;rpc?.close();await new Promise(resolve=>server.close(resolve));}
}

/* Local HTTP/QR pairing tests with mocked Signal and filesystem; no real linking or messages. */
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),{strict:assert}=require('node:assert');
const root=globalThis.__GREENY_TEST_ROOT__||path.resolve(__dirname,'..'),virtual=globalThis.__GREENY_TEST_FILES__||{},read=file=>Object.prototype.hasOwnProperty.call(virtual,file)?virtual[file]:fs.readFileSync(path.join(root,file),'utf8');
const esbuild=createRequire(path.join(root,'spa/package.json'))('esbuild'),checks=[];const check=(value,name)=>{assert(value,name);checks.push(name);};
(async()=>{
 const qrModule={exports:{}};new Function('module','exports',read('tools/signal/vendor/qrcode.cjs'))(qrModule,qrModule.exports);
 const saved=[],cfg={account_number:'+85240000001',bridge_key:'a'.repeat(64),device_id:'esp32-sensor'},runtime='/mock/.signal-runtime';
 const bridge={RUNTIME:runtime,readConfig:async()=>({...cfg}),runtimePaths:async()=>({java:'unused',classpath:'unused'}),atomicJSON:async(file,value)=>{saved.push({file,value:structuredClone(value)});}};
 const compiled=await esbuild.transform(read('tools/signal/pair.mjs'),{format:'cjs',target:'node24',loader:'js'}),mod={exports:{}};
 new Function('require','module','exports','console',compiled.code)(name=>name==='./bridge.mjs'?bridge:name==='./vendor/qrcode.cjs'?qrModule.exports:require(name),mod,mod.exports,{log(){},error(){}});
 const {pairPhone,pairPage,qrSVG,linkURI,localRequest}=mod.exports;
 const uri='sgnl://linkdevice?uuid=TEST&pub_key=TEST&capabilities=nopni';
 check(linkURI(uri)===uri,'Signal link URI retained without leaking through external URL');
 for(const bad of ['https://example.com/?uuid=a&pub_key=b','sgnl://other?uuid=a&pub_key=b','sgnl://linkdevice?uuid=a']){assert.throws(()=>linkURI(bad));checks.push('invalid Signal URI rejected');}
 const svg=qrSVG(uri);check(svg.includes('width="440"')&&svg.includes('shape-rendering="crispEdges"')&&svg.includes('fill="#fff"')&&!svg.includes(uri),'local SVG uses crisp black modules and white quiet zone without URI text');
 const html=pairPage('abc123');const script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];await esbuild.transform(script,{target:'es2022',loader:'js'});checks.push('browser pairing JavaScript parses');
 check(!html.includes('src="http')&&html.includes('重新產生配對碼'),'pair page has no external QR service or script');
 const origin='http://127.0.0.1:1234',base='/pair/nonce';
 check(localRequest({method:'POST',url:base+'/start',headers:{host:'127.0.0.1:1234',origin,'content-type':'application/json'}},origin,base),'same-origin start request accepted');
 check(!localRequest({method:'POST',url:base+'/start',headers:{host:'127.0.0.1:1234',origin:'https://attacker.example','content-type':'application/json'}},origin,base),'foreign origin cannot initiate pairing');
 check(!localRequest({method:'GET',url:base+'/',headers:{host:'attacker.example'}},origin,base),'foreign Host is rejected');
 const clients=[];let url;const ready=new Promise(resolve=>{url=resolve;});
 const makeRPC=()=>{const client={number:clients.length,linked:false,closed:false,async call(method,params){if(method==='listAccounts')return this.linked?[{number:cfg.account_number,aci:'11111111-1111-4111-8111-111111111111'}]:[];if(method==='startLink')return {deviceLinkUri:uri+'&attempt='+this.number};if(method==='finishLink'){this.params=params;return new Promise((resolve,reject)=>{this.finish=()=>{this.linked=true;resolve({number:cfg.account_number});};this.reject=reject;});}throw new Error('Unexpected Signal operation');},close(){this.closed=true;this.reject?.(new Error('Signal process stopped'));}};clients.push(client);return client;};
 const session=pairPhone({makeRPC,onListening:value=>url(value)}),pageURL=await ready,rootURL=pageURL.replace(/\/$/,'');
 const state=async()=>await(await fetch(rootURL+'/state')).json();const wait=async phase=>{for(let i=0;i<100;i++){const s=await state();if(s.phase===phase)return s;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Pairing phase not reached: '+phase);};
 check((await state()).phase==='idle'&&clients.length===0,'pair code is not generated until the phone is ready');
 const page=await fetch(pageURL);check(page.status===200&&page.headers.get('content-security-policy').includes("frame-ancestors 'none'"),'local pairing page has restricted CSP');
 const rejected=await fetch(rootURL+'/start',{method:'POST',headers:{Origin:'https://attacker.example','Content-Type':'application/json'},body:'{}'});check(rejected.status===404&&clients.length===0,'cross-site HTTP start attempt cannot create a link');
 const start=()=>fetch(rootURL+'/start',{method:'POST',headers:{Origin:new URL(pageURL).origin,'Content-Type':'application/json'},body:'{}'});
 check((await start()).status===202,'browser starts pairing explicitly');const waiting=await wait('waiting');check(waiting.svg.startsWith('<svg')&&clients[0].params.deviceName==='Greeny2 Note to Self','fresh QR is paired with the currently waiting Signal RPC');
 await start();await wait('waiting');check(clients.length===2&&clients[0].closed,'regenerate closes expired pairing and starts a new session');clients[1].finish();await wait('linked');
 check(saved.some(row=>row.file.endsWith('.greeny2-signal-private.json')&&row.value.account_aci==='11111111-1111-4111-8111-111111111111'),'paired account is checked before identity is saved');
 check(saved.filter(row=>row.file.endsWith('pair-session.json')).every(row=>!JSON.stringify(row.value).includes('pub_key')),'pairing link URI is never written to session status');
 await session;check(clients[1].closed,'successful session closes its Signal RPC');
 console.log(JSON.stringify({passed:checks.length,failed:0,checks,realSignalLinking:false,filesystemWrites:false}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});

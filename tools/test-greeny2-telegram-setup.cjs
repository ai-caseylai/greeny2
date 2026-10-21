/* Local setup guards and secret-entry tests; no real network, account changes or file writes. */
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url'),{PassThrough,Writable}=require('node:stream');
const root=globalThis.__GREENY_TEST_ROOT__||path.resolve(__dirname,'..'),virtual=globalThis.__GREENY_TEST_FILES__||{};
const read=p=>Object.prototype.hasOwnProperty.call(virtual,p)?virtual[p]:fs.readFileSync(path.join(root,p),'utf8');
const tests=[];function check(ok,name){if(!ok)throw new Error(name);tests.push({name,passed:true});}
function denied(fn){try{fn();return false;}catch{return true;}}
(async()=>{
 const source=read('tools/telegram/setup.mjs').replaceAll('import.meta.url',JSON.stringify(pathToFileURL(path.join(root,'tools/telegram/setup.mjs')).href));
 const api=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const c={base_url:'https://greeny2.openezit.com',device_id:'esp32-sensor',account_number:'+85240000001',bot_username:'greeny2_bot',bot_token:'123456:'+ 'T'.repeat(35),webhook_secret:'c'.repeat(64)};
 check(api.validatePrivate(c)===c,'valid dedicated Bot configuration is accepted');
 check(denied(()=>api.validatePrivate({...c,base_url:'https://other.example'})),'private credentials cannot redirect Cloud requests');
 check(denied(()=>api.validatePrivate({...c,bot_username:'other_bot'})),'only the customer selected Bot may be provisioned');
 check(denied(()=>api.validatePrivate({...c,bot_token:'not-a-token'})),'invalid Bot tokens are rejected before network calls');
 check(denied(()=>api.validatePrivate({...c,account_number:'123'})),'authorized phone must be in E.164 format');
 check(denied(()=>api.validatePrivate({...c,webhook_secret:''})),'missing webhook verification secret is rejected');
 check(api.validateWebhook({url:''}).url===''&&api.validateWebhook({url:c.base_url+'/api/telegram/webhook'}).url.endsWith('/webhook'),'new or same-installation webhooks can be configured');
 check(denied(()=>api.validateWebhook({url:'https://another.example/hook'})),'an unrelated existing webhook is preserved');
 const generated={account_id:'3df8aa5f7718e535dfb690343b98e986',name:'greeny2',d1_databases:[{database_name:'greeny2-db',database_id:'own-database'}],durable_objects:{bindings:[{name:'TELEGRAM_HUB',class_name:'TelegramHub'}]}};
 check(!denied(()=>api.validateGenerated(generated,{database_id:'own-database'})),'own account, database and Telegram binding are required');
 check(denied(()=>api.validateGenerated({...generated,account_id:'other'},{database_id:'own-database'})),'deployment cannot target another Cloudflare account');
 check(denied(()=>api.validateGenerated(generated,{database_id:'different'})),'deployment cannot target another database');
 check(denied(()=>api.validateGenerated({...generated,containers:[{}]},{database_id:'own-database'})),'setup refuses a configuration with paid Containers');
 const link='https://t.me/greeny2_bot?start='+ 'A'.repeat(32),svg=api.qrSVG(link),page=api.pairPage(link,'abc123');
 check(svg.includes('<svg')&&svg.includes('viewBox=')&&!svg.includes('sgnl:'),'pairing QR is generated locally for Telegram');
 check(page.includes('確認手機號碼')&&page.includes('ec?')&&page.includes('temp?')&&page.includes('ph?'),'phone pairing page explains number verification and the three sensor queries');
 check(!page.includes('src="https://')&&!page.includes('api.telegram.org')&&!page.includes(c.bot_token),'pairing page loads no external QR service or Bot credentials');
 check(denied(()=>api.qrSVG('https://evil.example/?start='+ 'A'.repeat(32))),'QR generation rejects unexpected external targets');
 const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};let printed='';const outputStream=new Writable({write(chunk,_encoding,done){printed+=chunk.toString();done();}});
 const entered=api.hiddenInput('Token: ',{input,outputStream});setTimeout(()=>input.write(c.bot_token+'\r'),10);const token=await entered;
 check(token===c.bot_token&&printed.includes('Token: ')&&!printed.includes(c.bot_token),'interactive Bot Token input is hidden and never echoed');
 check(read('.gitignore').includes('.greeny2-telegram-private.json')&&read('.gitignore').includes('.telegram-runtime/'),'private Bot credentials and pairing runtime are excluded from Git');
 const config=JSON.parse(read('edge/wrangler.openezit.jsonc').replace(/^\s*\/\/.*$/mg,''));
 check(!config.containers&&config.migrations.some(m=>m.new_sqlite_classes?.includes('TelegramHub')),'Telegram uses Free-plan compatible SQLite Durable Objects without Containers');
 console.log(JSON.stringify({passed:tests.length,failed:0,tests,networkRequests:false,filesystemWrites:false}));
})().catch(error=>{console.error(JSON.stringify({passed:tests.length,failed:1,error:error.message,stack:error.stack}));process.exitCode=1;});

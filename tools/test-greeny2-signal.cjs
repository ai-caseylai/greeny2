/* In-memory Signal protocol and delivery tests; no real Signal messages or file writes. */
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
const {strict:assert}=require('node:assert');
const root=globalThis.__GREENY_TEST_ROOT__||path.resolve(__dirname,'..'),virtual=globalThis.__GREENY_TEST_FILES__||{};
const read=file=>Object.prototype.hasOwnProperty.call(virtual,file)?virtual[file]:fs.readFileSync(path.join(root,file),'utf8');
const requireRepo=createRequire(path.join(root,'spa/package.json')),esbuild=requireRepo('esbuild');
const results=[];const check=(condition,name)=>{assert(condition,name);results.push(name);};
(async()=>{
const built=await esbuild.build({stdin:{contents:read('tools/signal/bridge.mjs'),sourcefile:'bridge.mjs',resolveDir:path.join(root,'tools/signal')},bundle:true,write:false,platform:'node',target:'node24',format:'cjs',define:{'import.meta.url':JSON.stringify(pathToFileURL(path.join(root,'tools/signal/bridge.mjs')).href)},plugins:[{name:'signal-memory',setup(build){build.onResolve({filter:/^\.\/protocol\.mjs$/},()=>({path:'tools/signal/protocol.mjs',namespace:'signal'}));build.onLoad({filter:/.*/,namespace:'signal'},args=>({contents:read(args.path),loader:'js'}));}}]});
const moduleUnderTest={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(require,moduleUnderTest,moduleUnderTest.exports);const {QueryJournal,handleQuery,validateConfig}=moduleUnderTest.exports;
const proto=await esbuild.transform(read('tools/signal/protocol.mjs'),{format:'cjs',target:'node24',loader:'js'});const protocolMod={exports:{}};new Function('require','module','exports',proto.code)(require,protocolMod,protocolMod.exports);const {selfQuery,queryField}=protocolMod.exports;
const now=Date.now(),cfg={base_url:'https://greeny2.openezit.com',device_id:'esp32-sensor',mode:'note_to_self',account_number:'+85240000001',account_aci:'11111111-1111-4111-8111-111111111111',bridge_key:'a'.repeat(64)};
const event={jsonrpc:'2.0',method:'receive',params:{account:cfg.account_number,envelope:{sourceNumber:cfg.account_number,sourceUuid:cfg.account_aci,sourceDevice:1,syncMessage:{sentMessage:{destinationNumber:cfg.account_number,timestamp:now,message:'ec?'}}}}};
const copy=()=>structuredClone(event),query=selfQuery(event,cfg,now);
check(query.field==='ec'&&query.message==='ec?'&&query.id.length===64,'note to self query is parsed');
check(queryField(' PH？ ')==='ph'&&queryField('temp?')==='temp'&&queryField('relay on')===null,'query parser ignores control instructions');
let v=copy();v.params.envelope.syncMessage.sentMessage.destinationNumber='+85240000000';check(selfQuery(v,cfg,now)===null,'outgoing query to another contact is ignored');
v=copy();v.params.envelope.sourceNumber='+85240000000';v.params.envelope.sourceUuid='other';check(selfQuery(v,cfg,now)===null,'another sender is ignored');
v=copy();v.params.envelope.syncMessage.sentMessage.groupInfo={groupId:'x'};check(selfQuery(v,cfg,now)===null,'group messages are ignored');
v=copy();v.params.envelope.syncMessage.sentMessage.timestamp=now-120001;check(selfQuery(v,cfg,now)===null,'old backlog is ignored');
v=copy();v.params.envelope.syncMessage.sentMessage.timestamp=now+5001;check(selfQuery(v,cfg,now)===null,'future messages are ignored');
v=copy();v.params.envelope.syncMessage.sentMessage.message='0';check(selfQuery(v,cfg,now)===null,'own replies cannot form a reply loop');
v=copy();v.params.envelope.dataMessage={message:'ph?',timestamp:now};delete v.params.envelope.syncMessage;check(selfQuery(v,cfg,now)===null,'ordinary incoming chats are ignored');
v=copy();v.params.envelope.syncMessage.sentMessage.destinationUuid=cfg.account_aci;delete v.params.envelope.syncMessage.sentMessage.destinationNumber;check(selfQuery(v,cfg,now)?.field==='ec','private phone-number UUID destination is supported');
v=copy();v.params={subscription:0,result:v.params};check(selfQuery(v,cfg,now)?.field==='ec','subscribed JSON-RPC event wrapper is supported');
check(validateConfig(cfg)===cfg,'valid scoped configuration accepted');assert.throws(()=>validateConfig({...cfg,base_url:'http://example.com'}));results.push('plaintext/untrusted Cloud endpoint rejected');
const journal=new QueryJournal(':memory:');const sent=[];let reads=0;const rpc={async call(method,params){sent.push({method,params});return {timestamp:now};}};const ask=async()=>{reads++;return {reply:'0',fresh:true};};
const first=await handleQuery(query,cfg,journal,rpc,ask);check(first.status==='sent'&&sent.length===1&&sent[0].method==='send'&&sent[0].params.noteToSelf===true&&sent[0].params.message==='0','real zero answer is sent only to Note to Self');
const duplicate=await handleQuery(query,cfg,journal,rpc,ask);check(duplicate.status==='duplicate'&&reads===1&&sent.length===1,'duplicate notification cannot produce another Cloud read or reply');
const q2={...query,id:'b'.repeat(64),field:'ph',message:'ph?'};const uncertain=await handleQuery(q2,cfg,journal,{call:async()=>{throw new Error('timeout');}},ask);check(uncertain.status==='uncertain','send timeout remains uncertain rather than reporting delivered');
check((await handleQuery(q2,cfg,journal,rpc,ask)).status==='duplicate'&&sent.length===1,'uncertain sends are not replayed automatically');
const q3={...query,id:'c'.repeat(64)};await handleQuery(q3,cfg,journal,rpc,async()=>{throw new Error('Cloud unavailable');});check(sent.at(-1).params.message.includes('暫時未能')&&!/9\.91/.test(sent.at(-1).params.message),'Cloud failure reports unavailable without fabricated data');
check(journal.resume(now).length===0,'terminal replies do not resume after restart');journal.close();

const {EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');let fakeProcess,lastWire,mode='ok',notification=null;
const fakeLaunch=(file,args)=>{fakeProcess=new EventEmitter();fakeProcess.stdout=new PassThrough();fakeProcess.stderr=new PassThrough();fakeProcess.stdin=new Writable({write(chunk,encoding,callback){const text=chunk.toString();lastWire={text,value:JSON.parse(text)};callback();if(mode!=='drop')setImmediate(()=>fakeProcess.stdout.write(JSON.stringify(mode==='error'?{id:lastWire.value.id,error:{code:429}}:{id:lastWire.value.id,result:{timestamp:now}})+'\n'));}});fakeProcess.kill=()=>{fakeProcess.stdout.end();fakeProcess.emit('close',0);};return fakeProcess;};
const rpcClient=new moduleUnderTest.exports.SignalRPC('fake-java','fake-classpath',cfg.account_number,value=>notification=value,fakeLaunch);
const rpcResponse=await rpcClient.call('send',{noteToSelf:true,message:'0'},2000);check(rpcResponse.timestamp===now&&lastWire.text.endsWith('\n')&&lastWire.value.jsonrpc==='2.0'&&lastWire.value.params.noteToSelf===true,'JSON-RPC sends one valid newline-delimited Note to Self request');
fakeProcess.stdout.write(JSON.stringify({method:'receive',params:{envelope:{}}})+'\n');check(notification?.method==='receive','Signal receive notifications are forwarded to event filter');
mode='error';await assert.rejects(rpcClient.call('send',{},2000),/429/);results.push('Signal RPC errors reject delivery');
mode='drop';await assert.rejects(rpcClient.call('send',{},15),/timeout/);results.push('Signal RPC response timeout rejects delivery');
const disconnected=rpcClient.call('send',{},2000);fakeProcess.emit('close',1);await assert.rejects(disconnected,/stopped/);results.push('Signal process closure rejects pending requests');rpcClient.close();


const setupCompiled=await esbuild.transform(read('tools/signal/setup.mjs'),{format:'cjs',target:'node24',loader:'js',define:{'import.meta.url':JSON.stringify(pathToFileURL(path.join(root,'tools/signal/setup.mjs')).href)}});
const setupMod={exports:{}};new Function('require','module','exports',setupCompiled.code)(name=>name==='./bridge.mjs'?moduleUnderTest.exports:require(name),setupMod,setupMod.exports);const {archiveRoot}=setupMod.exports;
check(archiveRoot('./\nsignal-cli-0.14.9/\nsignal-cli-0.14.9/lib/main.jar\n')==='signal-cli-0.14.9','Signal archive top-level dot directory is safely ignored');
check(archiveRoot('./signal-cli-0.14.9/\n./signal-cli-0.14.9/lib/main.jar')==='signal-cli-0.14.9','leading dot slash paths normalise to one root');
check(archiveRoot('jdk-25.0.4.1+1-jre/\njdk-25.0.4.1+1-jre/bin/java.exe')==='jdk-25.0.4.1+1-jre','actual Java archive root is accepted');
for(const [text,label] of [['../escape/x','parent traversal'],['./../escape/x','normalised parent traversal'],['/root/x','absolute path'],['C:/root/x','Windows drive path'],['root\\x','Windows separators'],['one/x\ntwo/x','multiple archive roots'],['./\n.\n','empty archive']]){assert.throws(()=>archiveRoot(text));results.push('archive rejects '+label);}

console.log(JSON.stringify({passed:results.length,failed:0,tests:results,physicalOutputsTouched:false,signalMessagesSent:false,filesystemWrites:false}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});

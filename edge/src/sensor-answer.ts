import {hkTime,SAMPLE_FRESH_MS} from './stamplc-protocol';
export type SensorField='ec'|'temp'|'ph';
export function sensorField(message:unknown):SensorField|null {
  if(typeof message!=='string')return null;
  const text=message.trim().toLowerCase().replace(/\s+/g,'').replace(/[?？]$/,'');
  if(['ec','電導率','电导率'].includes(text))return 'ec';
  if(['temp','temperature','溫度','温度'].includes(text))return 'temp';
  if(['ph','ph值','酸鹼值','酸碱值'].includes(text))return 'ph';
  return null;
}
export function sensorFacts(data:any,id:string,now=Date.now()) {
  const utc=Number.isSafeInteger(data.utc_ms)?data.utc_ms:null,received=Number.isSafeInteger(data.received_ms)?data.received_ms:null;
  const fresh=data.status==='ok'&&data.connected===true&&utc!==null&&received!==null&&utc<=now+2000&&received<=now+2000&&now-utc<=SAMPLE_FRESH_MS&&now-received<=SAMPLE_FRESH_MS;
  return {device_id:id,ph:typeof data.ph==='number'&&Number.isFinite(data.ph)?data.ph:null,ec:typeof data.ec==='number'&&Number.isFinite(data.ec)?data.ec:null,ec_unit:'µS/cm',temp:typeof data.temp==='number'&&Number.isFinite(data.temp)?data.temp:null,temp_unit:'°C',tds:data.tds??null,tds_status:data.tds==null?'未量測':'measured',utc_ms:utc,date_time_hk:utc!==null?hkTime(utc):null,received_ms:received,received_time_hk:received!==null?hkTime(received):null,fresh,connected:data.connected===true,reported_relays:data.reported_relays??[null,null,null,null],relay_valid:data.relay_valid===true,relay_readback:'GPIO readback, not contact feedback'};
}
export function sampleNotice(facts:ReturnType<typeof sensorFacts>):string {
  if(facts.utc_ms===null)return '尚未收到有效感測資料。';
  return (facts.connected?'資料已過期':'裝置離線')+'；以下是最後讀數，非即時。採樣時間：'+facts.date_time_hk+'（香港）。';
}
export function sensorAnswer(field:SensorField,facts:ReturnType<typeof sensorFacts>):string {
  const value=facts[field];
  if(facts.utc_ms===null||value===null)return '目前沒有可用的'+(field==='temp'?'溫度':field==='ph'?'pH':'EC')+'讀數。'+(!facts.fresh?sampleNotice(facts):'');
  const number=field==='ph'?value.toFixed(2):field==='temp'?value.toFixed(1):String(Number(value.toFixed(2)));
  return facts.fresh?number:sampleNotice(facts)+'\n'+(field==='temp'?'溫度':field==='ph'?'pH':'EC')+'：'+number+(field==='temp'?' °C':field==='ec'?' µS/cm':'');
}

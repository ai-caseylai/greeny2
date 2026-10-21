import {createHash} from 'node:crypto';
export function queryField(text){if(typeof text!=='string')return null;const value=text.trim().toLowerCase().replace(/\s+/g,'').replace(/[?？]$/,'');return ['ec','temp','ph'].includes(value)?value:null;}
export function selfQuery(event,config,now=Date.now()){
  if(event?.method!=='receive')return null;
  const data=event.params?.result??event.params;if(!data||data.account&&data.account!==config.account_number&&data.account!==config.account_aci)return null;
  const envelope=data.envelope,sent=envelope?.syncMessage?.sentMessage;
  if(!sent||sent.groupInfo||sent.groupId||sent.isViewOnce||sent.viewOnce)return null;
  const fromSelf=envelope.sourceNumber===config.account_number||envelope.source===config.account_number||!!config.account_aci&&envelope.sourceUuid===config.account_aci;
  const toSelf=sent.destinationNumber===config.account_number||sent.destination===config.account_number||!!config.account_aci&&(sent.destinationUuid===config.account_aci||sent.destination===config.account_aci);
  const field=queryField(sent.message),timestamp=sent.timestamp;
  if(!fromSelf||!toSelf||!field||!Number.isSafeInteger(timestamp)||timestamp>now+5000||now-timestamp>120000)return null;
  const id=createHash('sha256').update([config.account_number,envelope.sourceDevice??'',timestamp,field].join('|')).digest('hex');
  return {id,field,message:field+'?',timestamp};
}

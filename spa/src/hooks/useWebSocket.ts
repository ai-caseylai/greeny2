import { useEffect, useRef, useCallback, useState } from 'react'
import { apiFetch, dashboardUrl, getToken } from '../lib/api'
import { useAuth } from './useAuth'

type MessageHandler = (data: any) => void
export type RelayChannel = 1 | 2 | 3 | 4
export interface RelayCommand { command_id:string; channel:RelayChannel; state:boolean; status:'pending'|'applied'|'observed'|'error'; message:string; accepted:boolean; issued_ms:number; expires_ms:number }
type Relays = [boolean|null,boolean|null,boolean|null,boolean|null]
const unknownRelays = ():Relays => [null,null,null,null]
const validRelays = (value:any):Relays|null => Array.isArray(value) && value.length===4 && value.every(x=>typeof x==='boolean'||x===null) ? [...value] as Relays : null
const channel = (value:any):value is RelayChannel => Number.isInteger(value)&&value>=1&&value<=4

export function useWebSocket(deviceId: string | number | null) {
  const { user }=useAuth()
  const canControl=user?.role==='superadmin'||user?.role==='office_admin'
  const wsRef=useRef<WebSocket|null>(null)
  const handlersRef=useRef<Map<string,Set<MessageHandler>>>(new Map())
  const commandsRef=useRef<Partial<Record<RelayChannel,RelayCommand>>>({})
  const timersRef=useRef<Partial<Record<RelayChannel,number>>>({})
  const snapshotRef=useRef<any>(null)
  const onlineRef=useRef(false)
  const [connected,setConnected]=useState(false)
  const [deviceConnected,setDeviceConnected]=useState(false)
  const [reportedRelays,setReportedRelays]=useState<Relays>(unknownRelays)
  const [relayValid,setRelayValid]=useState(false)
  const [pendingRelays,setPendingRelays]=useState<any[]>([])
  const [relayCommands,setRelayCommands]=useState<Partial<Record<RelayChannel,RelayCommand>>>({})
  const [liveReading,setLiveReading]=useState<any>(null)
  const [wifiNetworks,setWifiNetworks]=useState<any[]>([])
  const [wifiScanning,setWifiScanning]=useState(false)
  const [wifiAck,setWifiAck]=useState<{success:boolean;message:string}|null>(null)

  const putCommand=useCallback((c:RelayCommand)=>{
    commandsRef.current={...commandsRef.current,[c.channel]:c};setRelayCommands(commandsRef.current)
    if(c.status!=='pending'){window.clearTimeout(timersRef.current[c.channel]);delete timersRef.current[c.channel]}
  },[])
  const applySnapshot=useCallback((msg:any)=>{
    if(msg.device_id && String(msg.device_id)!==String(deviceId))return
    const sample=(msg.type==='state'||msg.type==='telemetry_update') && ['ph','ec','temp','utc_ms'].every(key=>Object.prototype.hasOwnProperty.call(msg,key)) && typeof msg.utc_ms==='number' ? {...msg} : null
    msg={...snapshotRef.current,...msg}
    snapshotRef.current=msg
    const online=msg.device_connected ?? msg.connected
    if(typeof online==='boolean'){onlineRef.current=online;setDeviceConnected(online)}
    const actual=validRelays(msg.reported_relays)
    if(actual)setReportedRelays(actual)
    if(typeof msg.relay_valid==='boolean')setRelayValid(msg.relay_valid)
    const pending=Array.isArray(msg.pending_relays)?msg.pending_relays.filter((p:any)=>channel(p.channel)&&typeof p.command_id==='string'):[]
    setPendingRelays(pending)
    if(sample)setLiveReading(sample)
    if(actual && msg.relay_valid===true && typeof msg.relay_reported_ms==='number'){
      for(const c of Object.values(commandsRef.current)){
        if(c?.status==='pending' && c.accepted && msg.relay_reported_ms>=c.issued_ms && actual[c.channel-1]===c.state && !pending.some((p:any)=>p.command_id===c.command_id))putCommand({...c,status:'observed',message:'已回報目標狀態（遙測確認）'})
      }
    }
  },[deviceId,putCommand])

  useEffect(()=>{
    let stopped=false,reconnect=0,ping=0
    onlineRef.current=false;snapshotRef.current=null;commandsRef.current={}
    setConnected(false);setDeviceConnected(false);setRelayValid(false);setReportedRelays(unknownRelays());setPendingRelays([]);setRelayCommands({});setLiveReading(null)
    const open=()=>{
      const token=getToken();if(stopped||!deviceId||!token)return
      const ws=new WebSocket(dashboardUrl(String(deviceId),token));wsRef.current=ws
      ws.onopen=()=>{if(stopped||wsRef.current!==ws)return;setConnected(true);ping=window.setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'ping'}))},30000)}
      ws.onmessage=event=>{
        if(stopped||wsRef.current!==ws)return
        let msg:any;try{msg=JSON.parse(event.data)}catch{return}
        if(msg.device_id && String(msg.device_id)!==String(deviceId))return
        if(msg.type==='state'||msg.type==='relay_state'||msg.type==='telemetry_update')applySnapshot(msg)
        if(msg.type==='device_status'){
          const online=msg.status==='online';onlineRef.current=online;setDeviceConnected(online)
          if(!online){setRelayValid(false);snapshotRef.current={...snapshotRef.current,relay_valid:false,connected:false,device_connected:false}}
        }
        if(msg.type==='relay_ack'){
          const actual=validRelays(msg.reported_relays);if(actual)setReportedRelays(actual)
          if(typeof msg.relay_valid==='boolean')setRelayValid(msg.relay_valid)
          const ackChannel=msg.channel
          const c=channel(ackChannel)?commandsRef.current[ackChannel]:undefined
          if(c?.status==='pending'&&c.command_id===msg.command_id&&c.state===msg.state){
            if(msg.status==='applied'&&msg.relay_valid===true&&actual?.[c.channel-1]===c.state)putCommand({...c,status:'applied',message:'裝置已確認（ACK）'})
            else if(msg.status==='rejected'||msg.status==='error')putCommand({...c,status:'error',message:typeof msg.error==='string'?msg.error:'裝置未執行指令'})
          }
          if(['applied','rejected','error'].includes(msg.status))applySnapshot({reported_relays:actual ?? snapshotRef.current?.reported_relays,relay_valid:msg.relay_valid ?? snapshotRef.current?.relay_valid,pending_relays:(snapshotRef.current?.pending_relays||[]).filter((p:any)=>p.command_id!==msg.command_id)})
        }
        if(msg.type==='wifi_list'){setWifiNetworks(msg.networks||[]);setWifiScanning(false)}
        if(msg.type==='wifi_ack')setWifiAck({success:msg.status==='ok',message:msg.ip||msg.msg||msg.status||''})
        for(const fn of [...(handlersRef.current.get(msg.type)||[]),...(handlersRef.current.get('*')||[])]){try{fn(msg)}catch{/* isolate subscribers */}}
      }
      ws.onclose=()=>{
        window.clearInterval(ping)
        if(stopped||wsRef.current!==ws)return
        wsRef.current=null;onlineRef.current=false;setConnected(false);setDeviceConnected(false);setRelayValid(false)
        for(const c of Object.values(commandsRef.current))if(c?.status==='pending')putCommand({...c,status:'error',message:'Cloud 連線中斷，指令結果未確認；請查看裝置狀態'})
        reconnect=window.setTimeout(open,5000)
      }
      ws.onerror=()=>ws.close()
    }
    open()
    return ()=>{stopped=true;window.clearTimeout(reconnect);window.clearInterval(ping);for(const timer of Object.values(timersRef.current))window.clearTimeout(timer);timersRef.current={};const ws=wsRef.current;wsRef.current=null;if(ws){ws.onclose=null;ws.close()}}
  },[deviceId,applySnapshot,putCommand])

  const on=useCallback((type:string,handler:MessageHandler)=>{
    if(!handlersRef.current.has(type))handlersRef.current.set(type,new Set())
    handlersRef.current.get(type)!.add(handler)
    return ()=>{handlersRef.current.get(type)?.delete(handler)}
  },[])

  const setRelay=useCallback(async (ch:RelayChannel,state:boolean)=>{
    if(!canControl)throw new Error('此帳號只可查看')
    if(!deviceId||!onlineRef.current||wsRef.current?.readyState!==WebSocket.OPEN)throw new Error('裝置尚未在線，未送出指令')
    const snap=snapshotRef.current
    const actual=validRelays(snap?.reported_relays)
    if(!channel(ch)||snap?.relay_valid!==true||!actual||typeof actual[ch-1]!=='boolean')throw new Error('尚未收到繼電器狀態，未送出指令')
    if(commandsRef.current[ch]?.status==='pending'||snap?.pending_relays?.some((p:any)=>p.channel===ch))throw new Error('此繼電器仍有待確認指令')
    const id=crypto.randomUUID(),issued=Date.now()
    const c:RelayCommand={command_id:id,channel:ch,state,status:'pending',message:'等待裝置確認',accepted:false,issued_ms:issued,expires_ms:issued+20000}
    putCommand(c)
    timersRef.current[ch]=window.setTimeout(()=>{const current=commandsRef.current[ch];if(current?.command_id===id&&current.status==='pending')putCommand({...current,status:'error',message:'確認逾時，狀態未確認；請查看實際回報'})},20000)
    const controller=new AbortController(),requestTimer=window.setTimeout(()=>controller.abort(),8000)
    try{
      const result=await apiFetch<any>('/api/relay',{method:'POST',signal:controller.signal,body:JSON.stringify({device_id:String(deviceId),command_id:id,channel:ch,state})})
      const current=commandsRef.current[ch]
      if(current?.command_id!==id||current.status!=='pending')return
      if(result.command_id!==id||result.accepted!==true)throw new Error('Cloud 未接受指令，請查看裝置狀態')
      const acceptedPending=result.state?.pending_relays?.find((p:any)=>p.command_id===id)
      putCommand({...current,accepted:true,issued_ms:acceptedPending?.issued_ms ?? issued,expires_ms:result.expires_ms ?? current.expires_ms})
      if(snapshotRef.current)applySnapshot(snapshotRef.current)
    }catch(error){
      const current=commandsRef.current[ch]
      if(current?.command_id===id&&current.status==='pending')putCommand({...current,status:'error',message:error instanceof Error&&error.name!=='AbortError'?error.message:'送出結果未確認；請查看裝置狀態'})
    }finally{window.clearTimeout(requestTimer)}
  },[canControl,deviceId,putCommand,applySnapshot])

  const sendCommand=useCallback((data:Record<string,unknown>)=>{
    if(!canControl||wsRef.current?.readyState!==WebSocket.OPEN)return false
    if(data.command==='wifi_scan'){setWifiScanning(true);window.setTimeout(()=>setWifiScanning(false),10000)}
    wsRef.current.send(JSON.stringify(data));return true
  },[canControl])
  return {connected,deviceConnected,reportedRelays,relayValid,pendingRelays,relayCommands,liveReading,canControl,setRelay,wifiNetworks,wifiScanning,wifiAck,on,sendCommand}
}

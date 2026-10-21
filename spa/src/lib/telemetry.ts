import type { Telemetry } from '../types'

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const epoch = (value: unknown): number | null => { const n=finite(value); return n!==null && n>=1704067200000 && n<2145916800000 ? n : null }

export function normalizeReading(raw: any, source: 'http' | 'ws'): Telemetry {
  const utc=epoch(raw.utc_ms ?? raw.sample_utc_ms ?? raw.sensor_utc_ms)
  const received=epoch(raw.received_ms ?? raw.do_ms ?? raw.doTs) ?? (source==='http' ? epoch((finite(raw.created_at) ?? 0) * 1000) : null)
  const ph=finite(raw.ph),ec=finite(raw.ec),temp=finite(raw.temp ?? raw.water_temp)
  return {
    device_id: String(raw.device_id ?? ''),
    ph: ph!==null && ph>=0 && ph<=14 ? ph : null,
    ec: ec!==null && ec>=0 ? ec : null,
    tds: finite(raw.tds),
    temp, water_temp:temp,
    utc_ms:utc, received_ms:received,
    ts_ms:utc ?? received ?? undefined,
    created_at: Math.floor((utc ?? received ?? 0)/1000),
    esp32_ms:finite(raw.esp32_ms) ?? undefined,
    led: raw.led===true || raw.led===1 ? 1 : raw.led===false || raw.led===0 ? 0 : undefined,
  }
}

export function isLiveReading(reading: Telemetry): boolean {
  return reading.utc_ms!==null && reading.utc_ms!==undefined &&
    (reading.ph!==null || reading.ec!==null || reading.temp!==null)
}

export function mergeReadings(...lists: Telemetry[][]): Telemetry[] {
  const seen=new Set<string>()
  return lists.flat().filter(row=>{
    if(!row.device_id || !row.ts_ms) return false
    const key=row.device_id+':'+row.ts_ms
    if(seen.has(key))return false
    seen.add(key);return true
  }).sort((a,b)=>(b.ts_ms ?? 0)-(a.ts_ms ?? 0)).slice(0,200)
}

export function formatSampleTime(row: Telemetry | null | undefined): string {
  if(!row?.utc_ms)return '採樣時間未提供'
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Hong_Kong',day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(row.utc_ms)
  const get=(type:string)=>parts.find(p=>p.type===type)?.value ?? '--'
  return get('day')+'-'+get('month')+'-'+get('year')+' '+get('hour')+':'+get('minute')+':'+get('second')+' (香港)'
}

export function formatReadingTime(row: Telemetry): string {
  if(row.utc_ms)return formatSampleTime(row)
  if(row.received_ms)return new Intl.DateTimeFormat('zh-Hant-HK',{timeZone:'Asia/Hong_Kong',dateStyle:'short',timeStyle:'medium'}).format(row.received_ms)+'（接收時間）'
  return '時間未提供'
}

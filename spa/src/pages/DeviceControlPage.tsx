import SampleTime from '../components/SampleTime'
import { useTranslation } from 'react-i18next'
import { useState, useMemo } from 'react'
import { useDevices } from '../hooks/useDevices'
import { useTelemetry } from '../hooks/useSensorData'
import { useWebSocket } from '../hooks/useWebSocket'
import type { RelayChannel } from '../hooks/useWebSocket'
import { normalizeReading, isLiveReading } from '../lib/telemetry'
import { Search, Droplets, Zap, Thermometer, Wifi, WifiOff, ToggleLeft, ToggleRight } from 'lucide-react'
import { timeAgo } from '../lib/utils'

const statusDotColors: Record<string, string> = {
  online: 'bg-green-500',
  offline: 'bg-gray-400',
  warning: 'bg-amber-500',
  maintenance: 'bg-blue-500',
  alarm: 'bg-red-500',
}

const statusBgColors: Record<string, string> = {
  online: 'border-green-200 bg-green-50/50',
  offline: 'border-gray-200 bg-gray-50/50',
  warning: 'border-amber-200 bg-amber-50/50',
  maintenance: 'border-blue-200 bg-blue-50/50',
  alarm: 'border-red-200 bg-red-50/50',
}

export default function DeviceControlPage() {
  const { t } = useTranslation()
  const { devices, loading } = useDevices()
  const { data: telemetry } = useTelemetry(undefined, 200)
  const [search, setSearch] = useState('')

  if (loading) return <div className="text-gray-400">{t('common.loading')}</div>

  const filtered = devices.filter(d =>
    !search || d.name.toLowerCase().includes(search.toLowerCase()) || (d.device_id || d.id).toLowerCase().includes(search.toLowerCase())
  )

  const onlineCount = devices.filter(d => d.status === 'online').length
  const offlineCount = devices.filter(d => d.status === 'offline').length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">{t('deviceControl.title')}</h2>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('common.search')}
              className="rounded-lg border border-border pl-8 pr-3 py-1.5 text-sm outline-none focus:border-[#00a65a] w-56"
            />
          </div>
          <span className="flex items-center gap-1.5 text-sm text-gray-500">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            Online {onlineCount}
          </span>
          <span className="flex items-center gap-1.5 text-sm text-gray-500">
            <span className="h-2 w-2 rounded-full bg-gray-400" />
            Offline {offlineCount}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {filtered.map((d) => (
          <DeviceCard key={d.device_id || d.id} device={d} telemetry={telemetry} />
        ))}
      </div>
    </div>
  )
}

function DeviceCard({ device: d, telemetry }: { device: any; telemetry: any[] }) {
  const { t } = useTranslation()
  const deviceId = d.device_id || d.id
  const { connected:wsConnected,deviceConnected,reportedRelays,relayValid,pendingRelays,relayCommands,liveReading,canControl,setRelay }=useWebSocket(deviceId)
  const [actionError,setActionError]=useState<string|null>(null)
  const received=useMemo(()=>liveReading ? normalizeReading(liveReading,'ws') : null,[liveReading])
  const latestT=received && isLiveReading(received) ? received : telemetry.find(row=>row.device_id===deviceId)
  const online=wsConnected && deviceConnected
  const status=online?'online':'offline'
  const command=async (channel:RelayChannel,state:boolean)=>{setActionError(null);try{await setRelay(channel,state)}catch(err){setActionError(err instanceof Error?err.message:'未能送出指令')}}
  return (
    <div className={'rounded-xl border p-5 shadow-sm transition-all hover:shadow-md '+statusBgColors[status]}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className={'h-2.5 w-2.5 rounded-full '+statusDotColors[status]} />
          <div><p className="font-semibold text-gray-900">{d.name}</p><p className="text-xs text-gray-400">{deviceId}</p></div>
        </div>
        <span className={'rounded-full px-2 py-0.5 text-xs font-medium '+(online?'bg-green-100 text-green-700':'bg-gray-100 text-gray-700')}>{online?t('deviceControl.online'):t('deviceControl.offline')}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="flex items-center gap-2"><Droplets className="h-3.5 w-3.5 text-blue-500"/><div><p className="text-[10px] text-gray-400">pH</p><p className="text-sm font-medium">{latestT?.ph?.toFixed(2) ?? '—'}</p></div></div>
        <div className="flex items-center gap-2"><Zap className="h-3.5 w-3.5 text-green-500"/><div><p className="text-[10px] text-gray-400">EC · µS/cm</p><p className="text-sm font-medium">{latestT?.ec?.toFixed(2) ?? '—'}</p></div></div>
        <div className="flex items-center gap-2"><Thermometer className="h-3.5 w-3.5 text-pink-500"/><div><p className="text-[10px] text-gray-400">溫度</p><p className="text-sm font-medium">{latestT?.water_temp?.toFixed(1) ?? '—'} °C</p></div></div>
        <div><p className="text-[10px] text-gray-400">TDS · ppm</p><p className="text-sm font-medium">{latestT?.tds!=null?latestT.tds.toFixed(2):'未提供'}</p></div>
      </div>
      <p className="mb-3 text-[10px] text-gray-500 break-words"><SampleTime reading={latestT} /></p>
      <div className="border-t border-border/50 pt-2 space-y-2">
        {([1,2,3,4] as RelayChannel[]).map(channel=>{
          const actual=reportedRelays[channel-1]
          const local=relayCommands[channel]
          const server=pendingRelays.find(p=>p.channel===channel)
          const pending=local?.status==='pending'||!!server
          const disabled=!canControl||!online||!relayValid||typeof actual!=='boolean'||pending
          const desired=local?.status==='pending'?local.state:server?.state
          return <div key={channel} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-gray-600">繼電器 {channel} · Relay {channel}</span>
              <button type="button" role="switch" aria-label={'繼電器 '+channel} aria-checked={actual===true} disabled={disabled}
                onClick={()=>{if(typeof actual==='boolean')void command(channel,!actual)}}
                className="flex items-center gap-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                {actual===true?<ToggleRight className="h-6 w-6 text-[#00a65a]"/>:<ToggleLeft className="h-6 w-6 text-gray-400"/>}
                {actual===null?'未知':actual?'開':'關'}
              </button>
            </div>
            <p aria-live="polite" className={'text-[10px] '+(local?.status==='error'?'text-red-600':pending?'text-amber-700':'text-gray-400')}>
              {pending?'等待裝置確認（目標：'+(desired?'開':'關')+'）':local?.message || (!relayValid?'等待有效輸出回報':'裝置輸出回讀')}
            </p>
          </div>
        })}
      </div>
      {!canControl && <p className="mt-3 text-xs text-gray-500">此帳號只可查看。</p>}
      {actionError && <p role="alert" className="mt-3 text-xs text-red-600">{actionError}</p>}
      <div className="flex items-center justify-between pt-3 text-[10px] text-gray-400">
        <span className={'flex items-center gap-1 '+(wsConnected?'text-green-600':'')}>{wsConnected?<Wifi className="h-3 w-3"/>:<WifiOff className="h-3 w-3"/>}{wsConnected?'Cloud 已連線':'Cloud 未連線'}</span>
        <span>{d.last_seen?timeAgo(d.last_seen):t('common.never')}</span>
      </div>
    </div>
  )
}

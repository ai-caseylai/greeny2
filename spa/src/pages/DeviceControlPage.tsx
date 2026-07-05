import { useState } from 'react'
import { useDevices } from '../hooks/useDevices'
import { useTelemetry } from '../hooks/useSensorData'
import { useWebSocket } from '../hooks/useWebSocket'
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
  const { devices, loading } = useDevices()
  const { data: telemetry } = useTelemetry(undefined, 200)
  const [search, setSearch] = useState('')

  if (loading) return <div className="text-gray-400">Loading...</div>

  const filtered = devices.filter(d =>
    !search || d.name.toLowerCase().includes(search.toLowerCase()) || (d.device_id || d.id).toLowerCase().includes(search.toLowerCase())
  )

  const onlineCount = devices.filter(d => d.status === 'online').length
  const offlineCount = devices.filter(d => d.status === 'offline').length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">Device Control</h2>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search devices..."
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
  const deviceId = d.device_id || d.id
  const { connected: wsConnected, ledState, toggleLed } = useWebSocket(deviceId)
  const latestT = telemetry.find((t: any) => t.device_id === deviceId)

  // LED state precedence: WS live > telemetry polling > off
  const ledOn = ledState !== null
    ? ledState
    : (latestT?.led === 1 || latestT?.led === true)

  const [toggling, setToggling] = useState(false)

  const handleToggle = async () => {
    setToggling(true)
    await toggleLed(deviceId, !ledOn)
    setToggling(false)
  }

  const statusLabel = d.status === 'online' ? 'Online' : d.status === 'offline' ? 'Offline' :
    d.status === 'warning' ? 'Warning' : d.status === 'alarm' ? 'Alarm' :
    d.status === 'maintenance' ? 'Maintenance' : d.status

  return (
    <div className={`rounded-xl border p-5 shadow-sm transition-all hover:shadow-md ${statusBgColors[d.status] || 'border-border bg-white'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${statusDotColors[d.status] || 'bg-gray-400'}`} />
          <div>
            <p className="font-semibold text-gray-900">{d.name}</p>
            <p className="text-xs text-gray-400">{d.device_id || d.id}</p>
          </div>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
          d.status === 'online' ? 'bg-green-100 text-green-700' :
          d.status === 'warning' || d.status === 'alarm' ? 'bg-amber-100 text-amber-700' :
          d.status === 'maintenance' ? 'bg-blue-100 text-blue-700' :
          'bg-gray-100 text-gray-700'
        }`}>
          {statusLabel}
        </span>
      </div>

      {/* Sensor readings */}
      {latestT && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="flex items-center gap-2">
            <Droplets className="h-3.5 w-3.5 text-blue-500" />
            <div>
              <p className="text-[10px] text-gray-400">pH</p>
              <p className="text-sm font-medium">{latestT.ph?.toFixed(2) ?? '-'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Zap className="h-3.5 w-3.5 text-green-500" />
            <div>
              <p className="text-[10px] text-gray-400">TDS</p>
              <p className="text-sm font-medium">{latestT.tds != null ? Math.round(latestT.tds) : (latestT.ec != null ? Math.round(latestT.ec) : '-')} ppm</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Thermometer className="h-3.5 w-3.5 text-pink-500" />
            <div>
              <p className="text-[10px] text-gray-400">Temp</p>
              <p className="text-sm font-medium">{latestT.water_temp?.toFixed(1) ?? '-'}°C</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Zap className="h-3.5 w-3.5 text-yellow-500" />
            <div>
              <p className="text-[10px] text-gray-400">EC</p>
              <p className="text-sm font-medium">{latestT.ec?.toFixed(1) ?? '-'}</p>
            </div>
          </div>
        </div>
      )}

      {/* LED Toggle */}
      <div className="flex items-center justify-between pt-3 border-t border-border/50">
        <div className="flex items-center gap-2">
          <button
            onClick={handleToggle}
            disabled={toggling}
            className={`flex items-center gap-1.5 text-xs transition-opacity ${toggling ? 'opacity-50' : ''}`}
          >
            {ledOn
              ? <ToggleRight className="h-5 w-5 text-[#00a65a]" />
              : <ToggleLeft className="h-5 w-5 text-gray-400" />
            }
            <span className={ledOn ? 'text-[#00a65a] font-medium' : 'text-gray-500'}>LED</span>
          </button>
          <span className={`h-1.5 w-1.5 rounded-full ${ledOn ? 'bg-[#00a65a] animate-pulse' : 'bg-gray-300'}`} />
        </div>
        <span className={`flex items-center gap-1 text-[10px] ${wsConnected ? 'text-green-600' : 'text-gray-400'}`}>
          {wsConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {wsConnected ? 'Live' : 'Polling'}
        </span>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-2 text-[10px] text-gray-400">
        <span>{d.last_seen ? timeAgo(d.last_seen) : 'Never'}</span>
      </div>
    </div>
  )
}

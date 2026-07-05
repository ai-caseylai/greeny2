import { useState, useEffect, useMemo } from 'react'
import { useDevices } from '../hooks/useDevices'
import { useTelemetry, normalizeReading } from '../hooks/useSensorData'
import { useWebSocket } from '../hooks/useWebSocket'
import { Droplets, Thermometer, Zap, RefreshCw, Leaf } from 'lucide-react'
import { formatTime, timeAgo } from '../lib/utils'
import type { Telemetry } from '../types'

// Raw SVG history chart — survives streaming data re-renders
function HistoryChart({ data, color, height = 260 }: {
  data: { time: string; value: number | null }[]
  color: string
  height?: number
}) {
  const points = data
    .map((d, i) => ({ x: i, y: d.value, label: d.time }))
    .filter(p => p.y != null && !isNaN(p.y) && isFinite(p.y))

  if (points.length < 2) {
    return <div className="flex items-center justify-center text-xs text-gray-400" style={{ height }}>No data</div>
  }

  const ys = points.map(p => p.y as number)
  const yMin = Math.min(...ys)
  const yMax = Math.max(...ys)
  const yPad = (yMax - yMin) * 0.2 || 1
  const vMin = yMin - yPad
  const vMax = yMax + yPad
  const vRange = vMax - vMin

  // Fixed pixel coordinates — same approach as Dashboard Sparkline
  const W = 600
  const H = height
  const padL = 40, padR = 10, padT = 10, padB = 20
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const tx = (i: number) => padL + (i / (points.length - 1)) * plotW
  const ty = (v: number) => padT + ((vMax - v) / vRange) * plotH

  const pathD = points.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${tx(i).toFixed(1)} ${ty(p.y!).toFixed(1)}`
  ).join('')

  // Y-axis ticks
  const yTicks = [vMin, (vMin + vMax) / 2, vMax].map(v => ({
    y: ty(v),
    label: Number.isInteger(v) ? String(v) : v.toFixed(1),
  }))

  // X-axis time labels (~4 evenly spaced)
  const xTickInterval = Math.max(1, Math.floor(points.length / 4))
  const xTicks = points.filter((_, i) => i % xTickInterval === 0 || i === points.length - 1)

  const lastX = tx(points.length - 1)
  const lastY = ty(points[points.length - 1].y!)
  const bottomY = padT + plotH

  return (
    <svg width="100%" height={H} xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', maxWidth: W }}>
      {/* Grid lines */}
      {yTicks.map(t => (
        <line key={t.label} x1={padL} y1={t.y.toFixed(1)} x2={padL + plotW} y2={t.y.toFixed(1)}
          stroke="#f0f0f0" strokeWidth={0.5} />
      ))}
      {/* Y-axis labels */}
      {yTicks.map(t => (
        <text key={t.label} x={padL - 4} y={t.y.toFixed(1)}
          textAnchor="end" fontSize={10} fill="#9ca3af" dominantBaseline="middle">{t.label}</text>
      ))}
      {/* X-axis labels */}
      {xTicks.map(t => (
        <text key={t.label} x={tx(t.x).toFixed(1)} y={H - 4}
          textAnchor="middle" fontSize={9} fill="#9ca3af">{t.label}</text>
      ))}
      {/* Fill */}
      <path d={`${pathD} L${lastX.toFixed(1)} ${bottomY} L${padL} ${bottomY} Z`}
        fill={color} fillOpacity={0.06} />
      {/* Line */}
      <path d={pathD} fill="none" stroke={color} strokeWidth={1.5}
        strokeLinecap="round" strokeLinejoin="round" />
      {/* Dot */}
      <circle cx={lastX.toFixed(1)} cy={lastY.toFixed(1)} r={2.5} fill={color} />
    </svg>
  )
}

function GaugeCard({ label, value, unit, icon: Icon, color, min, max, optimal }: {
  label: string; value: number | null; unit: string; icon: React.ElementType
  color: string; min: number; max: number; optimal: [number, number]
}) {
  const pct = value !== null ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0
  const inRange = value !== null && value >= optimal[0] && value <= optimal[1]
  return (
    <div className={`rounded-lg border bg-gray-50 p-3 transition-all ${!inRange ? 'border-amber-300 ring-2 ring-amber-400 ring-offset-1' : 'border-gray-100'}`}>
      <div className="flex items-center gap-1.5 mb-2">
        <Icon className={`h-3.5 w-3.5 ${!inRange ? 'animate-pulse' : ''}`} style={{ color }} />
        <span className="text-xs text-gray-500">{label}</span>
      </div>
      <div className="flex items-baseline gap-0.5 mb-2">
        <span className="text-xl font-bold text-gray-900">{value !== null ? (Number.isInteger(value) ? value : value.toFixed(1)) : '-'}</span>
        <span className="text-[10px] text-gray-400">{unit}</span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-200 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${!inRange ? 'animate-pulse' : ''}`}
          style={{ width: `${pct}%`, backgroundColor: inRange ? color : '#FF9800' }} />
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-gray-400">
        <span>{min}</span>
        <span className={inRange ? 'text-green-600' : 'text-amber-600 font-medium'}>{inRange ? 'Normal' : '⚠ Abnormal'}</span>
        <span>{max}</span>
      </div>
    </div>
  )
}

const METRICS = [
  { key: 'pH', label: 'pH', color: '#2196F3', unit: '' },
  { key: 'TDS', label: 'TDS', color: '#FF9800', unit: 'ppm' },
  { key: 'EC', label: 'EC', color: '#4CAF50', unit: 'µS/cm' },
  { key: 'Temp', label: 'Temp', color: '#E91E63', unit: '°C' },
]

export default function WaterQualityPage() {
  const { devices: initialDevices } = useDevices()
  const { data: initialTelemetry, refetch } = useTelemetry(undefined, 200)

  const firstDeviceId = initialDevices[0]?.device_id || initialDevices[0]?.id || null
  const { connected: wsConnected, on } = useWebSocket(firstDeviceId)

  const [wsTelemetry, setWsTelemetry] = useState<Telemetry[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const [activeMetric, setActiveMetric] = useState<string>('pH')
  const [page, setPage] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now())
  const pageSize = 5

  // WS: state → collect WS entries
  useEffect(() => {
    return on('state', (msg: any) => {
      const entry = normalizeReading(msg, 'ws')
      if (!entry.device_id) return
      setWsTelemetry(prev => {
        const rest = prev.filter(t => t.device_id !== entry.device_id)
        return [entry, ...rest].slice(0, 200)
      })
      setLastRefresh(Date.now())
    })
  }, [on])

  // Merge HTTP seed + WS entries — HTTP is the base, WS prepends on top
  const telemetry = useMemo(() => {
    const seen = new Set<string>()
    const merged: Telemetry[] = []
    for (const t of wsTelemetry) {
      const key = `${t.device_id}-${t.ts_ms}`
      if (!seen.has(key)) { seen.add(key); merged.push(t) }
    }
    for (const t of initialTelemetry) {
      const key = `${t.device_id}-${t.ts_ms}`
      if (!seen.has(key)) { seen.add(key); merged.push(t) }
    }
    return merged.slice(0, 200)
  }, [initialTelemetry, wsTelemetry])

  const handleRefresh = async () => {
    setRefreshing(true)
    await refetch()
    setLastRefresh(Date.now())
    setRefreshing(false)
  }

  const deviceTelemetry = selectedDeviceId
    ? telemetry.filter(t => t.device_id === selectedDeviceId)
    : telemetry

  const latest = deviceTelemetry.length > 0 ? deviceTelemetry[0] : null
  const pageData = deviceTelemetry.slice(page * pageSize, (page + 1) * pageSize)
  const totalPages = Math.ceil(deviceTelemetry.length / pageSize)

  // Chart data: single metric, last 50 points, oldest first
  const chartData = [...deviceTelemetry].slice(0, 50).reverse().map((r) => ({
    time: new Date(r.ts_ms ?? (r.created_at * 1000)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    value: activeMetric === 'pH' ? Number(r.ph?.toFixed(2))
      : activeMetric === 'TDS' ? Math.round(r.tds ?? r.ec ?? 0)
      : activeMetric === 'EC' ? Number((r.ec ?? 0).toFixed(1))
      : Number((r.water_temp ?? 0).toFixed(1)),
  }))

  const activeMetricDef = METRICS.find(m => m.key === activeMetric)!

  const devices = initialDevices

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">Sensors</h2>
        <button onClick={handleRefresh} disabled={refreshing}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50">
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />Refresh
        </button>
      </div>

      {/* Status strip */}
      <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-100 text-[10px] text-gray-500">
        <span className={`inline-flex items-center gap-1 ${wsConnected ? 'text-green-600' : 'text-red-500'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${wsConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
          {wsConnected ? 'Live' : 'Polling'}
        </span>
        <span className="text-gray-300">·</span>
        <span>{firstDeviceId || '—'}</span>
        <span className="text-gray-300">·</span>
        <span>Updated {timeAgo(lastRefresh)}</span>
        <span className="text-gray-300">·</span>
        <span>{deviceTelemetry.length} readings</span>
      </div>

      {devices.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-12 text-center">
          <Droplets className="mx-auto h-12 w-12 text-gray-300" />
          <p className="mt-3 text-gray-500">No devices found</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-white shadow-sm overflow-hidden">
            {/* Header with device selector */}
            <div className="flex items-center justify-between px-5 py-3 bg-gradient-to-r from-green-50 to-white border-b border-border">
              <div className="flex items-center gap-2">
                <Leaf className="h-4 w-4 text-[#2E7D32]" />
                <h3 className="text-sm font-semibold text-gray-800">
                  {selectedDeviceId
                    ? devices.find(d => (d.device_id || d.id) === selectedDeviceId)?.name || selectedDeviceId
                    : devices[0]?.name || 'Device'}
                </h3>
              </div>
              <div className="flex items-center gap-3">
                <select
                  value={selectedDeviceId || firstDeviceId || ''}
                  onChange={(e) => { setSelectedDeviceId(e.target.value); setPage(0) }}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs"
                >
                  {devices.map(d => (
                    <option key={d.device_id || d.id} value={d.device_id || d.id}>{d.name}</option>
                  ))}
                </select>
                {latest && (
                  <span className="text-[10px] text-gray-400">Last reading: {formatTime(latest.created_at)}</span>
                )}
              </div>
            </div>

            {/* Gauge cards */}
            <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <GaugeCard label="pH" value={latest?.ph ?? null} unit="" icon={Droplets} color="#2196F3" min={0} max={14} optimal={[5.5, 7.5]} />
              <GaugeCard label="EC" value={latest?.ec ?? null} unit="µS/cm" icon={Zap} color="#4CAF50" min={0} max={3000} optimal={[800, 1500]} />
              <GaugeCard label="TDS" value={latest?.tds ?? latest?.ec ?? null} unit="ppm" icon={Zap} color="#FF9800" min={0} max={2000} optimal={[100, 1000]} />
              <GaugeCard label="Temp" value={latest?.water_temp ?? null} unit="°C" icon={Thermometer} color="#E91E63" min={0} max={50} optimal={[18, 28]} />
            </div>

            {/* Chart with metric toggle */}
            <div className="px-5 pb-4">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold text-gray-600">History — {activeMetricDef.label}</h4>
                <div className="flex gap-1">
                  {METRICS.map(m => (
                    <button key={m.key} onClick={() => setActiveMetric(m.key)}
                      className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                        activeMetric === m.key
                          ? 'text-white'
                          : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      }`}
                      style={activeMetric === m.key ? { backgroundColor: m.color } : {}}
                    >
                      {m.key === 'Temp' ? '°C' : m.key}
                    </button>
                  ))}
                </div>
              </div>
              <HistoryChart data={chartData} color={activeMetricDef.color} height={260} />
            </div>

            {/* Data table */}
            <div className="border-t border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-gray-50 text-left text-gray-500">
                    <th className="px-4 py-2">pH</th><th className="px-4 py-2">EC</th><th className="px-4 py-2">TDS</th>
                    <th className="px-4 py-2">°C</th><th className="px-4 py-2">LED</th><th className="px-4 py-2">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {pageData.map((r: any, i: number) => (
                    <tr key={i} className="border-b border-border/30 hover:bg-gray-50/50">
                      <td className="px-4 py-2">{r.ph?.toFixed(2)}</td>
                      <td className="px-4 py-2">{r.ec?.toFixed(1)}</td>
                      <td className="px-4 py-2">{r.tds != null ? Math.round(r.tds) : (r.ec != null ? Math.round(r.ec) : '-')}</td>
                      <td className="px-4 py-2">{r.water_temp?.toFixed(1)}</td>
                      <td className="px-4 py-2">{r.led != null ? (r.led ? 'ON' : 'OFF') : '-'}</td>
                      <td className="px-4 py-2 text-gray-400">{formatTime(r.created_at)}</td>
                    </tr>
                  ))}
                  {pageData.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No data</td></tr>
                  )}
                </tbody>
              </table>
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-gray-50/30">
                  <span className="text-[10px] text-gray-400">{deviceTelemetry.length} records</span>
                  <div className="flex gap-1">
                    <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}
                      className="rounded px-2 py-0.5 text-[10px] border border-border disabled:opacity-30 hover:bg-gray-50">Prev</button>
                    <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1}
                      className="rounded px-2 py-0.5 text-[10px] border border-border disabled:opacity-30 hover:bg-gray-50">Next</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

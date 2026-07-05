import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useDevices } from '../hooks/useDevices'
import { useTelemetry, normalizeReading } from '../hooks/useSensorData'
import { useWebSocket } from '../hooks/useWebSocket'
import { Cpu, Droplets, Thermometer, RefreshCw, Zap, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { timeAgo } from '../lib/utils'
import type { Telemetry, Device } from '../types'

// ── Animated value with micro-transition ──
function AnimatedValue({ value, prev }: { value: string; prev: string | null }) {
  const changed = prev !== null && prev !== value
  return (
    <span className="relative inline-block">
      <span
        key={value}
        className="inline-block animate-in"
        style={{ '--tw-enter-scale': '1.1' } as React.CSSProperties}
      >
        {value}
      </span>
      {changed && (
        <span className="absolute -top-1 -right-3 text-[10px] leading-none opacity-70 animate-in fade-in slide-in-from-bottom-1 duration-300">
          {parseFloat(value) > parseFloat(prev!) ? (
            <TrendingUp className="h-2.5 w-2.5 text-green-500" />
          ) : (
            <TrendingDown className="h-2.5 w-2.5 text-red-500" />
          )}
        </span>
      )}
    </span>
  )
}

// ── Trend direction indicator ──
function TrendIcon({ current, previous }: { current: number | null; previous: number | null }) {
  if (current == null || previous == null || current === previous) {
    return <Minus className="h-3 w-3 text-gray-300" />
  }
  return current > previous
    ? <TrendingUp className="h-3 w-3 text-green-500" />
    : <TrendingDown className="h-3 w-3 text-red-500" />
}

// ── Raw SVG sparkline with hover tooltip ──
function Sparkline({ data, dataKey, color, height = 100 }: {
  data: { time: string; [key: string]: any }[]
  dataKey: string
  color: string
  height?: number
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; value: string; time: string } | null>(null)

  const points = useMemo(() => data
    .map((d, i) => ({ x: i, y: d[dataKey] as number | null, time: d.time }))
    .filter(p => p.y != null && !isNaN(p.y) && isFinite(p.y)),
  [data, dataKey])

  if (points.length < 2) {
    return <div className="flex items-center justify-center text-xs text-gray-400" style={{ height }}>No data</div>
  }

  const ys = points.map(p => p.y!)
  const yMin = Math.min(...ys), yMax = Math.max(...ys)
  const yPad = (yMax - yMin) * 0.2 || 1
  const vMin = yMin - yPad, vMax = yMax + yPad, vRange = vMax - vMin

  const W = 400, H = height
  const padL = 4, padR = 4, padT = 4, padB = 4
  const plotW = W - padL - padR, plotH = H - padT - padB

  const tx = (i: number) => padL + (i / (points.length - 1)) * plotW
  const ty = (v: number) => padT + ((vMax - v) / vRange) * plotH

  const pathD = points.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${tx(i).toFixed(1)} ${ty(p.y!).toFixed(1)}`
  ).join('')

  const lastX = tx(points.length - 1), lastY = ty(points[points.length - 1].y!)
  const bottomY = padT + plotH

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const mouseX = ((e.clientX - rect.left) / rect.width) * W
    const idx = Math.round((mouseX - padL) / plotW * (points.length - 1))
    const clamped = Math.max(0, Math.min(points.length - 1, idx))
    const pt = points[clamped]
    setTooltip({
      x: tx(clamped), y: ty(pt.y!),
      value: pt.y!.toFixed(dataKey === 'pH' ? 2 : dataKey === 'Temp' || dataKey === 'EC' ? 1 : 0),
      time: pt.time,
    })
  }

  return (
    <div className="relative" style={{ height }}>
      <svg ref={svgRef} width="100%" height={H} xmlns="http://www.w3.org/2000/svg"
        style={{ display: 'block' }} onMouseMove={handleMouseMove} onMouseLeave={() => setTooltip(null)}>
        <rect width="100%" height={H} fill="transparent" />
        <path d={`${pathD} L${lastX.toFixed(1)} ${bottomY} L${padL} ${bottomY} Z`}
          fill={color} fillOpacity={0.06} />
        <path d={pathD} fill="none" stroke={color} strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={lastX.toFixed(1)} cy={lastY.toFixed(1)} r="2.5" fill={color} />
        {tooltip && (
          <line x1={tooltip.x.toFixed(1)} y1={padT} x2={tooltip.x.toFixed(1)} y2={padT + plotH}
            stroke={color} strokeWidth="0.5" opacity="0.4" strokeDasharray="3 3" />
        )}
      </svg>
      {tooltip && (
        <div className="absolute top-0 left-0 pointer-events-none bg-white border border-gray-200 rounded px-2 py-1 text-[10px] shadow-sm whitespace-nowrap"
          style={{ transform: `translate(${tooltip.x * 0.25}px, -24px)` }}>
          <span style={{ color }} className="font-medium">{tooltip.value}</span>
          <span className="text-gray-400 ml-1">{tooltip.time}</span>
        </div>
      )}
    </div>
  )
}

// ── DashboardPage ──
export default function DashboardPage() {
  const { devices: initialDevices, loading: devicesLoading } = useDevices()
  const { data: initialTelemetry, loading: telemetryLoading, refetch: refetchTelemetry } = useTelemetry(undefined, 200)

  const firstDeviceId = initialDevices[0]?.device_id || initialDevices[0]?.id || null
  const { connected: wsConnected, on } = useWebSocket(firstDeviceId)

  const [devices, setDevices] = useState<Device[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now())
  const [wsTelemetry, setWsTelemetry] = useState<Telemetry[]>([])

  // Track previous values for trend arrows
  const prevTelemetryRef = useRef<Telemetry | null>(null)
  const [prevTelemetry, setPrevTelemetry] = useState<Telemetry | null>(null)

  useEffect(() => { if (initialDevices.length > 0) setDevices(initialDevices) }, [initialDevices])

  // WS: state events
  useEffect(() => {
    return on('state', (msg: any) => {
      const entry = normalizeReading(msg, 'ws')
      if (!entry.device_id) return
      setWsTelemetry(prev => {
        const rest = prev.filter(t => t.device_id !== entry.device_id)
        return [entry, ...rest].slice(0, 200)
      })
      setLastRefresh(Date.now())
      if (typeof msg.connected === 'boolean') {
        setDevices(prev => prev.map(d =>
          (d.device_id || d.id) === msg.device_id ? { ...d, status: msg.connected ? 'online' : 'offline' } : d
        ))
      }
    })
  }, [on])

  // Merge HTTP + WS
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

  // Track previous telemetry for trend comparison
  useEffect(() => {
    if (telemetry.length >= 2) {
      setPrevTelemetry(prevTelemetryRef.current)
      prevTelemetryRef.current = telemetry[0]
    } else if (telemetry.length === 1) {
      prevTelemetryRef.current = telemetry[0]
    }
  }, [telemetry])

  // Safety net: poll HTTP when WS down
  useEffect(() => {
    if (wsConnected) return
    const id = setInterval(() => { refetchTelemetry(); setLastRefresh(Date.now()) }, 30000)
    return () => clearInterval(id)
  }, [wsConnected, refetchTelemetry])

  const loading = devicesLoading || telemetryLoading

  const handleRefresh = async () => {
    setRefreshing(true)
    await refetchTelemetry()
    setLastRefresh(Date.now())
    setRefreshing(false)
  }

  const latestTelemetry = telemetry.length > 0 ? telemetry[0] : null
  const onlineCount = devices.filter(d => d.status === 'online').length
  const totalDevices = devices.length
  const esp32Uptime = latestTelemetry?.ts_ms ? Math.floor(latestTelemetry.ts_ms / 1000) : null

  const kpiCards = [
    { label: 'Online Devices', valueStr: `${onlineCount}/${totalDevices}`, valueNum: null, icon: Cpu, color: '#4CAF50', unit: '' },
    { label: 'pH Level', valueStr: latestTelemetry?.ph != null ? latestTelemetry.ph.toFixed(2) : '-', valueNum: latestTelemetry?.ph ?? null, icon: Droplets, color: '#2196F3', unit: '' },
    { label: 'Temperature', valueStr: latestTelemetry?.water_temp != null ? `${latestTelemetry.water_temp.toFixed(1)}°C` : '-', valueNum: latestTelemetry?.water_temp ?? null, icon: Thermometer, color: '#E91E63', unit: '°C' },
    { label: 'TDS', valueStr: latestTelemetry?.tds != null ? `${Math.round(latestTelemetry.tds)} ppm` : (latestTelemetry?.ec != null ? `${Math.round(latestTelemetry.ec)} ppm` : '-'), valueNum: latestTelemetry?.tds ?? latestTelemetry?.ec ?? null, icon: Zap, color: '#FF9800', unit: 'ppm' },
    { label: 'EC', valueStr: latestTelemetry?.ec != null ? `${latestTelemetry.ec.toFixed(1)} µS/cm` : '-', valueNum: latestTelemetry?.ec ?? null, icon: TrendingUp, color: '#4CAF50', unit: 'µS/cm' },
  ]

  const sparkData = useMemo(() => {
    const last50 = [...telemetry].slice(0, 50).reverse()
    return last50.map(t => ({
      time: new Date(t.ts_ms ?? (t.created_at * 1000)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      pH: t.ph != null ? Number(t.ph.toFixed(2)) : null,
      Temp: t.water_temp != null ? Number(t.water_temp.toFixed(1)) : null,
      TDS: t.tds != null ? Math.round(t.tds) : (t.ec != null ? Math.round(t.ec) : null),
      EC: t.ec != null ? Number(t.ec.toFixed(1)) : null,
    }))
  }, [telemetry])

  const statusLabels: Record<string, string> = {
    online: 'Online', offline: 'Offline', warning: 'Warning',
    alarm: 'Alarm', maintenance: 'Maintenance',
  }
  const statusColors: Record<string, string> = {
    online: 'bg-green-500', offline: 'bg-gray-400', warning: 'bg-amber-500',
    maintenance: 'bg-blue-500', alarm: 'bg-red-500',
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-400">Loading...</div>
  }

  return (
    <div className="space-y-4">
      {/* Header + compact status strip */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">Dashboard</h2>
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
        <span>Uptime {esp32Uptime != null ? `${Math.floor(esp32Uptime / 1000)}s` : '—'}</span>
        <span className="text-gray-300">·</span>
        <span>Updated {timeAgo(lastRefresh)}</span>
        <span className="text-gray-300">·</span>
        <span>{telemetry.length} readings</span>
      </div>

      {/* KPI Cards with trend arrows + animated values */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {kpiCards.map((card, idx) => (
          <div key={card.label} className="rounded-xl border border-border bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">{card.label}</p>
                <div className="flex items-center gap-1.5 mt-1">
                  <p className="text-2xl font-bold text-gray-900">
                    {card.valueNum != null ? (
                      <AnimatedValue value={card.valueStr} prev={null} />
                    ) : (
                      card.valueStr
                    )}
                  </p>
                  {card.valueNum != null && prevTelemetry && (
                    <TrendIcon
                      current={card.valueNum}
                      previous={
                        card.label === 'pH Level' ? prevTelemetry.ph :
                        card.label === 'Temperature' ? prevTelemetry.water_temp :
                        card.label === 'TDS' ? (prevTelemetry.tds ?? prevTelemetry.ec) :
                        card.label === 'EC' ? prevTelemetry.ec :
                        null
                      }
                    />
                  )}
                </div>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg" style={{ backgroundColor: `${card.color}15` }}>
                <card.icon className="h-5 w-5" style={{ color: card.color }} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Sparkline Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Droplets className="h-3.5 w-3.5" style={{ color: '#2196F3' }} />
            <h3 className="text-xs font-semibold text-gray-700">pH</h3>
            <span className="text-[10px] text-gray-400">{sparkData.filter((d: any) => d.pH != null).length} pts</span>
          </div>
          <Sparkline data={sparkData} dataKey="pH" color="#2196F3" />
        </div>
        <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Thermometer className="h-3.5 w-3.5" style={{ color: '#E91E63' }} />
            <h3 className="text-xs font-semibold text-gray-700">Temperature</h3>
            <span className="text-[10px] text-gray-400">{sparkData.filter((d: any) => d.Temp != null).length} pts</span>
          </div>
          <Sparkline data={sparkData} dataKey="Temp" color="#E91E63" />
        </div>
        <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="h-3.5 w-3.5" style={{ color: '#FF9800' }} />
            <h3 className="text-xs font-semibold text-gray-700">TDS</h3>
            <span className="text-[10px] text-gray-400">{sparkData.filter((d: any) => d.TDS != null).length} pts</span>
          </div>
          <Sparkline data={sparkData} dataKey="TDS" color="#FF9800" />
        </div>
        <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="h-3.5 w-3.5" style={{ color: '#4CAF50' }} />
            <h3 className="text-xs font-semibold text-gray-700">EC</h3>
            <span className="text-[10px] text-gray-400">{sparkData.filter((d: any) => d.EC != null).length} pts</span>
          </div>
          <Sparkline data={sparkData} dataKey="EC" color="#4CAF50" />
        </div>
      </div>

      {/* Device Table */}
      <div className="rounded-xl border border-border bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-border"><h3 className="text-sm font-semibold text-gray-700">Devices</h3></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-gray-50 text-left text-gray-500">
                <th className="px-4 py-3">Device ID</th><th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">pH</th><th className="px-4 py-3">Temp</th>
                <th className="px-4 py-3">TDS</th><th className="px-4 py-3">EC</th>
                <th className="px-4 py-3">Status</th><th className="px-4 py-3">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => {
                const lt = telemetry.find((t) => t.device_id === d.device_id || t.device_id === d.id)
                return (
                  <tr key={d.device_id || d.id} className="border-b border-border/50 hover:bg-gray-50/50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">{d.device_id || d.id}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{d.name}</td>
                    <td className="px-4 py-3">{lt?.ph?.toFixed(2) || '-'}</td>
                    <td className="px-4 py-3">{lt?.water_temp?.toFixed(1) || '-'}°C</td>
                    <td className="px-4 py-3">{lt?.tds != null ? Math.round(lt.tds) : (lt?.ec != null ? Math.round(lt.ec) : '-')} ppm</td>
                    <td className="px-4 py-3">{lt?.ec?.toFixed(1) || '-'}</td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5">
                        <span className={`h-2 w-2 rounded-full ${statusColors[d.status] || 'bg-gray-400'}`} />{statusLabels[d.status] || d.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">{d.last_seen ? timeAgo(d.last_seen) : '-'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

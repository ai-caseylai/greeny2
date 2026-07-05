import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import type { Telemetry, Alert } from '../types'

export function useDashboardStats() {
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const fetchStats = useCallback(async () => {
    try {
      const data = await apiFetch<any>('/api/telemetry?limit=200')
      // Compute stats from telemetry since we don't have a dedicated stats endpoint
      const telemetry: Telemetry[] = data.telemetry || data || []
      if (telemetry.length > 0) {
        const latest = telemetry[0]
        setStats({
          online_devices: 1,
          total_devices: 1,
          today_alerts: 0,
          avg_ph: latest.ph,
          avg_temp: latest.temp ?? latest.water_temp,
          avg_ec: latest.tds ?? latest.ec,
        })
      }
    } catch {
      // handled by apiFetch
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchStats() }, [fetchStats])

  return { stats, loading, refetch: fetchStats }
}

// Normalize any reading (HTTP or WS) into a common shape.
// HTTP: { ph, ec, tds, temp, do_ms, created_at, led } — flat, temp not water_temp, do_ms for ts
// WS:   { type:"state", device_id, ph, tds, ec, temp, led:bool, connected, doTs, esp32_ms } — also flat
export function normalizeReading(raw: any, source: 'http' | 'ws'): Telemetry {
  if (source === 'ws') {
    // Prototype DO sends flat { type:"state", ph, tds, ec, temp, led, doTs }
    const tsMs = raw.doTs || Date.now()
    return {
      device_id: raw.device_id,
      ph: raw.ph,
      ec: raw.ec ?? raw.tds,
      tds: raw.tds ?? raw.ec,
      water_temp: raw.temp,
      temp: raw.temp,
      ts_ms: tsMs,
      created_at: Math.floor(tsMs / 1000),
      led: raw.led === true || raw.led === 1 ? 1 : 0,
    }
  }
  // HTTP source (REST API)
  return {
    device_id: raw.device_id,
    ph: raw.ph,
    ec: raw.ec,
    tds: raw.tds ?? raw.ec,
    water_temp: raw.temp ?? raw.water_temp,
    temp: raw.temp ?? raw.water_temp,
    ts_ms: raw.do_ms ?? (raw.created_at * 1000),
    created_at: raw.created_at,
    led: raw.led,
  }
}

export function useTelemetry(deviceId?: string, limit = 100, _officeId?: number | null) {
  const [data, setData] = useState<Telemetry[]>([])
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (deviceId) params.set('device_id', deviceId)
      params.set('limit', String(limit))
      params.set('_t', String(Date.now())) // bust Cloudflare CDN cache
      const result = await apiFetch<{ telemetry: Telemetry[] }>(`/api/telemetry?${params}`)
      const normalized = (result.telemetry || []).map((t: any) => normalizeReading(t, 'http'))
      setData(normalized)
    } catch {
      // handled by apiFetch
    } finally {
      setLoading(false)
    }
  }, [deviceId, limit])

  useEffect(() => { fetchData() }, [fetchData])

  return { data, loading, refetch: fetchData }
}

export function useAlerts(acknowledged?: number) {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)

  const fetchAlerts = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (acknowledged !== undefined) params.set('acknowledged', String(acknowledged))
      const data = await apiFetch<{ alerts: Alert[] }>(`/api/alerts?${params}`)
      setAlerts((data.alerts || []).map((a: any) => ({
        ...a,
        type: a.alert_type || a.type,
      })))
    } catch {
      // handled by apiFetch
    } finally {
      setLoading(false)
    }
  }, [acknowledged])

  useEffect(() => { fetchAlerts() }, [fetchAlerts])

  const acknowledge = useCallback(async (id: number) => {
    await apiFetch(`/api/alerts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ acknowledged: 1 }),
    })
    fetchAlerts()
  }, [fetchAlerts])

  return { alerts, loading, refetch: fetchAlerts, acknowledge }
}

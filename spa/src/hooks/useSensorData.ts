import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import type { Telemetry, Alert } from '../types'
import { normalizeReading, mergeReadings } from '../lib/telemetry'

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
          avg_ec: latest.ec,
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

export { normalizeReading } from '../lib/telemetry'

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
      setData(mergeReadings(normalized))
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
    // Worker 的警報確認端點是 POST /api/alerts/ack（body: {alert_id}）。
    // 舊版打 PATCH /api/alerts/<id> —— Worker 沒有那條路由，會回 404，
    // 等於「確認警報」按鈕完全無效（Pages 側才有 PATCH，但 SPA 走的是 apiFetch → Worker）。
    await apiFetch('/api/alerts/ack', {
      method: 'POST',
      body: JSON.stringify({ alert_id: id }),
    })
    fetchAlerts()
  }, [fetchAlerts])

  return { alerts, loading, refetch: fetchAlerts, acknowledge }
}

import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import type { Device } from '../types'

export function useDevices(_officeId?: number | null) {
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)

  const fetchDevices = useCallback(async () => {
    try {
      const data = await apiFetch<{ devices: Device[] }>('/api/devices')
      // Normalize: our backend uses device_id, Casey's code uses id
      const normalized = (data.devices || []).map((d: any) => ({
        ...d,
        id: d.device_id || d.id,
        location: d.location || '-',
        floor: d.floor || 1,
      }))
      setDevices(normalized)
    } catch {
      // handled by apiFetch
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchDevices() }, [fetchDevices])

  return { devices, loading, refetch: fetchDevices }
}

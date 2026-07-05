import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import type { Office } from '../types'

export function useOffices() {
  const [offices, setOffices] = useState<Office[]>([])
  const [loading, setLoading] = useState(true)

  const fetchOffices = useCallback(async () => {
    try {
      const data = await apiFetch<Office[]>('/api/offices')
      setOffices(data)
    } catch { /* */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchOffices() }, [fetchOffices])

  const createOffice = useCallback(async (office: Partial<Office>) => {
    const result = await apiFetch<Office>('/api/offices', { method: 'POST', body: JSON.stringify(office) })
    fetchOffices()
    return result
  }, [fetchOffices])

  const updateOffice = useCallback(async (id: number, updates: Partial<Office>) => {
    await apiFetch('/api/offices/' + id, { method: 'PUT', body: JSON.stringify(updates) })
    fetchOffices()
  }, [fetchOffices])

  const deleteOffice = useCallback(async (id: number) => {
    await apiFetch('/api/offices/' + id, { method: 'DELETE' })
    fetchOffices()
  }, [fetchOffices])

  return { offices, loading, refetch: fetchOffices, createOffice, updateOffice, deleteOffice }
}

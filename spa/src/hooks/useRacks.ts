import { useState, useEffect, useCallback } from 'react'
import { mgmtApiFetch } from '../lib/api'
import type { Rack, RackVegetable, RackEnvironment } from '../types'

export function useRacks(officeId?: number) {
  const [racks, setRacks] = useState<Rack[]>([])
  const [loading, setLoading] = useState(true)

  const fetchRacks = useCallback(async () => {
    try {
      const params = officeId ? '?office_id=' + officeId : ''
      const data = await mgmtApiFetch<Rack[]>('/api/racks' + params)
      setRacks(data)
    } catch { /* */ } finally {
      setLoading(false)
    }
  }, [officeId])

  useEffect(() => { fetchRacks() }, [fetchRacks])

  const createRack = useCallback(async (rack: Partial<Rack>) => {
    const result = await mgmtApiFetch<Rack>('/api/racks', { method: 'POST', body: JSON.stringify(rack) })
    fetchRacks()
    return result
  }, [fetchRacks])

  const updateRack = useCallback(async (id: number, updates: Partial<Rack>) => {
    await mgmtApiFetch('/api/racks/' + id, { method: 'PUT', body: JSON.stringify(updates) })
    fetchRacks()
  }, [fetchRacks])

  const deleteRack = useCallback(async (id: number) => {
    await mgmtApiFetch('/api/racks/' + id, { method: 'DELETE' })
    fetchRacks()
  }, [fetchRacks])

  return { racks, loading, refetch: fetchRacks, createRack, updateRack, deleteRack }
}

export function useRackVegetables(rackId?: number) {
  const [vegetables, setVegetables] = useState<RackVegetable[]>([])
  const [loading, setLoading] = useState(true)

  const fetchVegetables = useCallback(async () => {
    if (!rackId) { setVegetables([]); setLoading(false); return }
    try {
      const data = await mgmtApiFetch<RackVegetable[]>('/api/rack-vegetables?rack_id=' + rackId)
      setVegetables(data)
    } catch { /* */ } finally {
      setLoading(false)
    }
  }, [rackId])

  useEffect(() => { fetchVegetables() }, [fetchVegetables])

  const addVegetable = useCallback(async (veg: Partial<RackVegetable>) => {
    await mgmtApiFetch('/api/rack-vegetables', { method: 'POST', body: JSON.stringify({ ...veg, rack_id: rackId }) })
    fetchVegetables()
  }, [rackId, fetchVegetables])

  const updateVegetable = useCallback(async (id: number, updates: Partial<RackVegetable>) => {
    await mgmtApiFetch('/api/rack-vegetables/' + id, { method: 'PUT', body: JSON.stringify(updates) })
    fetchVegetables()
  }, [fetchVegetables])

  const deleteVegetable = useCallback(async (id: number) => {
    await mgmtApiFetch('/api/rack-vegetables/' + id, { method: 'DELETE' })
    fetchVegetables()
  }, [fetchVegetables])

  return { vegetables, loading, refetch: fetchVegetables, addVegetable, updateVegetable, deleteVegetable }
}

export function useRackEnvironment(rackId?: number) {
  const [records, setRecords] = useState<RackEnvironment[]>([])
  const [loading, setLoading] = useState(true)

  const fetchEnv = useCallback(async () => {
    if (!rackId) { setRecords([]); setLoading(false); return }
    try {
      const data = await mgmtApiFetch<RackEnvironment[]>('/api/rack-environment?rack_id=' + rackId)
      setRecords(data)
    } catch { /* */ } finally {
      setLoading(false)
    }
  }, [rackId])

  useEffect(() => { fetchEnv() }, [fetchEnv])

  const addRecord = useCallback(async (rec: Partial<RackEnvironment>) => {
    await mgmtApiFetch('/api/rack-environment', { method: 'POST', body: JSON.stringify({ ...rec, rack_id: rackId }) })
    fetchEnv()
  }, [rackId, fetchEnv])

  return { records, loading, refetch: fetchEnv, addRecord }
}

export function useAutomations() {
  const [automations, setAutomations] = useState<import('../types').Automation[]>([])
  const [loading, setLoading] = useState(true)

  const fetchAutomations = useCallback(async () => {
    try {
      const data = await mgmtApiFetch<import('../types').Automation[]>('/api/automations')
      setAutomations(data)
    } catch { /* */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAutomations() }, [fetchAutomations])

  const createAutomation = useCallback(async (auto: Partial<import('../types').Automation>) => {
    await mgmtApiFetch('/api/automations', { method: 'POST', body: JSON.stringify(auto) })
    fetchAutomations()
  }, [fetchAutomations])

  const updateAutomation = useCallback(async (id: number, updates: Partial<import('../types').Automation>) => {
    await mgmtApiFetch('/api/automations/' + id, { method: 'PUT', body: JSON.stringify(updates) })
    fetchAutomations()
  }, [fetchAutomations])

  const deleteAutomation = useCallback(async (id: number) => {
    await mgmtApiFetch('/api/automations/' + id, { method: 'DELETE' })
    fetchAutomations()
  }, [fetchAutomations])

  const runAutomation = useCallback(async (id: number) => {
    await mgmtApiFetch('/api/automations/' + id + '/run', { method: 'POST' })
    fetchAutomations()
  }, [fetchAutomations])

  return { automations, loading, refetch: fetchAutomations, createAutomation, updateAutomation, deleteAutomation, runAutomation }
}

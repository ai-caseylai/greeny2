import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Sprout, Scissors, Plus, Filter, X, TrendingUp, Package, Leaf, Calendar } from 'lucide-react'
import { useOffice } from '../context/OfficeContext'
import { useOffices } from '../hooks/useOffices'
import { useRacks } from '../hooks/useRacks'
import { useChineseText } from '../hooks/useChineseText'
import { apiFetch } from '../lib/api'

interface CropBatch {
  id: number
  office_id: number
  rack_id: number | null
  layer_number: number | null
  variety: string
  quantity: number
  unit: string
  status: 'growing' | 'ready' | 'harvested' | 'failed'
  seeded_at: number
  expected_harvest_days: number
  notes: string
  office_name?: string
  rack_name?: string
}

interface HarvestLog {
  id: number
  batch_id: number
  quantity: number
  unit: string
  quality: 'excellent' | 'good' | 'fair' | 'poor'
  notes: string
  harvested_at: number
  variety?: string
  office_name?: string
  rack_name?: string
}

function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' })
}

function daysSince(ts: number) {
  return Math.floor((Date.now() / 1000 - ts) / 86400)
}

function AddBatchForm({ offices, racks, userRole, lockedOfficeId, onSaved }: {
  offices: { id: number; name: string }[]
  racks: { id: number; name: string; office_id: number }[]
  userRole: string
  lockedOfficeId: number | null
  onSaved: () => void
}) {
  const { t } = useTranslation('crops')
  const ct = useChineseText()
  const [form, setForm] = useState({
    office_id: userRole === 'superadmin' ? '' : (lockedOfficeId?.toString() || ''),
    rack_id: '',
    variety: '',
    quantity: '',
    expected_harvest_days: '10',
    notes: '',
  })
  const [saving, setSaving] = useState(false)

  const filteredRacks = form.office_id
    ? racks.filter(r => r.office_id === Number(form.office_id))
    : racks

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.variety.trim()) {
      alert(t('messages.enterVariety'))
      return
    }
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {
        variety: form.variety.trim(),
        quantity: Number(form.quantity) || 0,
        unit: '株',
        expected_harvest_days: Number(form.expected_harvest_days) || 30,
        notes: form.notes,
      }
      if (form.office_id) payload.office_id = Number(form.office_id)
      if (form.rack_id) payload.rack_id = Number(form.rack_id)

      await apiFetch('/crop-batches', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      onSaved()
    } catch (err: any) {
      alert(t('messages.seedlingFailed') + (err.message || t('messages.unknownError')))
    }
    setSaving(false)
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-green-200 bg-green-50/50 p-5">
      <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
        <Sprout className="h-4 w-4 text-green-600" />{t('form.seedlingEntry')}
      </h3>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {userRole === 'superadmin' && (
          <div>
            <label className="block text-[10px] text-gray-500 mb-1">{t('form.office')}</label>
            <select value={form.office_id} onChange={e => setForm({ ...form, office_id: e.target.value, rack_id: '' })}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm">
              <option value="">-- Select --</option>
              {offices.map(o => <option key={o.id} value={o.id}>{ct(o.name)}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="block text-[10px] text-gray-500 mb-1">{t('form.rack')}</label>
          <select value={form.rack_id} onChange={e => setForm({ ...form, rack_id: e.target.value })}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm">
            <option value="">-- Select --</option>
            {filteredRacks.map(r => <option key={r.id} value={r.id}>{ct(r.name)}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 mb-1">{t('form.variety')}</label>
          <input value={form.variety} onChange={e => setForm({ ...form, variety: e.target.value })}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" required placeholder={t('form.varietyPlaceholder')} />
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 mb-1">{t('form.quantity')}</label>
          <input type="number" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" required placeholder="0" min="0" />
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 mb-1">{t('form.expectedDays')}</label>
          <input type="number" value={form.expected_harvest_days} onChange={e => setForm({ ...form, expected_harvest_days: e.target.value })}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" min="1" />
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 mb-1">{t('form.notes')}</label>
          <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
        </div>
      </div>
      <div className="flex gap-2 mt-3">
        <button type="submit" disabled={saving}
          className="rounded bg-green-600 px-4 py-1.5 text-sm text-white hover:bg-green-700 disabled:opacity-50">
          {saving ? t('form.planting') : t('form.plant')}
        </button>
      </div>
    </form>
  )
}

function HarvestModal({ batch, onSaved, onClose }: {
  batch: CropBatch
  onSaved: (msg: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation('crops')
  const ct = useChineseText()
  const [form, setForm] = useState({
    quantity: '',
    quality: 'good' as string,
    notes: '',
  })
  const [saving, setSaving] = useState(false)

  const handleSubmit = async () => {
    if (!form.quantity || Number(form.quantity) <= 0) {
      alert(t('messages.enterQuantity'))
      return
    }
    setSaving(true)
    try {
      await apiFetch('/harvests', {
        method: 'POST',
        body: JSON.stringify({
          batch_id: batch.id,
          quantity: Number(form.quantity) || 0,
          unit: batch.unit || '株',
          quality: form.quality,
          notes: form.notes,
        }),
      })
      setSaving(false)
      onSaved(t('harvest.success'))
      onClose()
    } catch (err: any) {
      setSaving(false)
      alert(t('messages.harvestFailed') + (err.message || t('messages.unknownError')))
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Scissors className="h-5 w-5 text-amber-500" />{t('harvest.title')}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
        </div>
        <div className="mb-4 rounded-lg bg-gray-50 p-3 text-sm">
          <p><strong>{ct(batch.variety)}</strong> — {batch.quantity}{ct(batch.unit)}</p>
          <p className="text-xs text-gray-500">{ct(batch.rack_name || '-')} · {t('harvest.planted')} {daysSince(batch.seeded_at)} {t('harvest.days')}</p>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('harvest.quantity')}</label>
              <input type="number" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm" min="0" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('harvest.quality')}</label>
            <select value={form.quality} onChange={e => setForm({ ...form, quality: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm">
              <option value="excellent">{t('harvest.qualityExcellent')}</option>
              <option value="good">{t('harvest.qualityGood')}</option>
              <option value="fair">{t('harvest.qualityFair')}</option>
              <option value="poor">{t('harvest.qualityPoor')}</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('harvest.notes')}</label>
            <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm" placeholder="Optional" />
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <button type="button" onClick={handleSubmit} disabled={saving}
            className="rounded-lg bg-amber-500 px-4 py-2 text-sm text-white hover:bg-amber-600 disabled:opacity-50">
            {saving ? t('harvest.recording') : t('harvest.confirm')}
          </button>
          <button type="button" onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
            {t('common:actions.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

function CropCalendar({ batches }: { batches: CropBatch[] }) {
  const { t } = useTranslation('crops')
  const ct = useChineseText()
  const [baseDate, setBaseDate] = useState(new Date())

  const year = baseDate.getFullYear()
  const month = baseDate.getMonth()
  const monthName = baseDate.toLocaleDateString('zh-TW', { year: 'numeric', month: 'long' })

  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const dateMap = useMemo(() => {
    const map = new Map<number, { seedlings: CropBatch[]; harvestExpected: CropBatch[] }>()
    batches.forEach(b => {
      const seededDate = new Date(b.seeded_at * 1000)
      if (seededDate.getFullYear() === year && seededDate.getMonth() === month) {
        const day = seededDate.getDate()
        if (!map.has(day)) map.set(day, { seedlings: [], harvestExpected: [] })
        map.get(day)!.seedlings.push(b)
      }
      const harvestTs = b.seeded_at + b.expected_harvest_days * 86400
      const harvestDate = new Date(harvestTs * 1000)
      if (harvestDate.getFullYear() === year && harvestDate.getMonth() === month) {
        const day = harvestDate.getDate()
        if (!map.has(day)) map.set(day, { seedlings: [], harvestExpected: [] })
        map.get(day)!.harvestExpected.push(b)
      }
    })
    return map
  }, [batches, year, month])

  const prevMonth = () => setBaseDate(new Date(year, month - 1, 1))
  const nextMonth = () => setBaseDate(new Date(year, month + 1, 1))
  const thisMonth = () => setBaseDate(new Date())

  const today = new Date()
  const isToday = (day: number) =>
    today.getFullYear() === year && today.getMonth() === month && today.getDate() === day

  const weekdays: string[] = t('calendar.weekdays', { returnObjects: true }) as string[]

  return (
    <div className="rounded-xl border border-border bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <Calendar className="h-4 w-4 text-green-600" />{t('calendar.title')}
        </h3>
        <div className="flex items-center gap-2">
          <button onClick={prevMonth} className="rounded border border-gray-200 px-2 py-1 text-xs hover:bg-gray-50">&lt;</button>
          <span className="text-sm font-medium min-w-[120px] text-center">{monthName}</span>
          <button onClick={nextMonth} className="rounded border border-gray-200 px-2 py-1 text-xs hover:bg-gray-50">&gt;</button>
          <button onClick={thisMonth} className="rounded border border-gray-200 px-2 py-1 text-xs hover:bg-gray-50">{t('calendar.today')}</button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-px bg-gray-100 rounded-lg overflow-hidden">
        {weekdays.map(d => (
          <div key={d} className="bg-gray-50 py-1.5 text-center text-[10px] font-medium text-gray-500">{d}</div>
        ))}
        {Array.from({ length: firstDay }, (_, i) => (
          <div key={`empty-${i}`} className="bg-white p-1.5 min-h-[64px]" />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1
          const info = dateMap.get(day)
          return (
            <div key={day} className={`bg-white p-1.5 min-h-[64px] ${isToday(day) ? 'ring-2 ring-green-400 ring-inset' : ''}`}>
              <div className={`text-[10px] font-medium ${isToday(day) ? 'text-green-600' : 'text-gray-400'}`}>{day}</div>
              {info && (
                <div className="mt-0.5 space-y-0.5">
                  {info.seedlings.map(b => (
                    <div key={`s-${b.id}`} className="flex items-center gap-0.5 rounded bg-green-100 px-1 py-px">
                      <Sprout className="h-2.5 w-2.5 text-green-600 shrink-0" />
                      <span className="text-[9px] text-green-700 truncate">{ct(b.variety)}</span>
                    </div>
                  ))}
                  {info.harvestExpected.map(b => (
                    <div key={`h-${b.id}`} className="flex items-center gap-0.5 rounded bg-amber-100 px-1 py-px">
                      <Scissors className="h-2.5 w-2.5 text-amber-600 shrink-0" />
                      <span className="text-[9px] text-amber-700 truncate">{ct(b.variety)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-4 mt-3 text-[10px] text-gray-500">
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded bg-green-400" />{t('calendar.seedling')}</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded bg-amber-400" />{t('calendar.expectedHarvest')}</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded ring-2 ring-green-400" />{t('calendar.today')}</span>
      </div>
    </div>
  )
}

export default function CropManagementPage() {
  const { t } = useTranslation('crops')
  const ct = useChineseText()
  const { selectedOfficeId, userRole, lockedOfficeId } = useOffice()
  const { offices } = useOffices()
  const { racks } = useRacks()
  const [batches, setBatches] = useState<CropBatch[]>([])
  const [harvests, setHarvests] = useState<HarvestLog[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'seedlings' | 'harvests'>('seedlings')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [showAdd, setShowAdd] = useState(false)
  const [harvestBatch, setHarvestBatch] = useState<CropBatch | null>(null)
  const [successMsg, setSuccessMsg] = useState('')

  const statusColorMap: Record<string, string> = {
    growing: 'bg-green-100 text-green-700',
    ready: 'bg-amber-100 text-amber-700',
    harvested: 'bg-blue-100 text-blue-700',
    failed: 'bg-red-100 text-red-700',
  }
  const statusDotMap: Record<string, string> = {
    growing: 'bg-green-500',
    ready: 'bg-amber-500',
    harvested: 'bg-blue-500',
    failed: 'bg-red-500',
  }
  const qualityColorMap: Record<string, string> = {
    excellent: 'text-green-600',
    good: 'text-blue-600',
    fair: 'text-amber-600',
    poor: 'text-red-600',
  }

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const officeParam = userRole === 'superadmin' && selectedOfficeId ? `?office_id=${selectedOfficeId}` : ''
      const batchUrl = `/crop-batches${statusFilter ? `${officeParam ? '&' : '?'}status=${statusFilter}` : officeParam}`
      const harvestUrl = `/harvests${officeParam}`

      const [batchData, harvestData] = await Promise.all([
        apiFetch<CropBatch[]>(batchUrl).catch(err => { console.error('crop-batches error:', err); return [] as CropBatch[] }),
        apiFetch<HarvestLog[]>(harvestUrl).catch(err => { console.error('harvests error:', err); return [] as HarvestLog[] }),
      ])
      setBatches(batchData)
      setHarvests(harvestData)
    } catch (err) { console.error('fetchData error:', err) }
    setLoading(false)
  }, [selectedOfficeId, userRole, statusFilter])

  useEffect(() => { fetchData() }, [fetchData])

  const growing = batches.filter(b => b.status === 'growing').length
  const ready = batches.filter(b => b.status === 'ready').length
  const totalHarvested = harvests.reduce((sum, h) => sum + h.quantity, 0)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">{t('title')}</h2>
          <p className="text-sm text-gray-500 mt-1">{t('subtitle')}</p>
        </div>
        <button onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700">
          <Plus className="h-4 w-4" />{t('newSeedling')}
        </button>
      </div>

      {successMsg && (
        <div className="rounded-lg bg-green-100 border border-green-300 px-4 py-2.5 text-sm text-green-800 font-medium">
          {successMsg}
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-green-200 bg-green-50 p-4">
          <div className="flex items-center gap-2">
            <Sprout className="h-5 w-5 text-green-600" />
            <span className="text-sm text-gray-600">{t('stats.growing')}</span>
          </div>
          <p className="mt-1 text-2xl font-bold text-green-700">{growing}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-center gap-2">
            <Leaf className="h-5 w-5 text-amber-600" />
            <span className="text-sm text-gray-600">{t('stats.ready')}</span>
          </div>
          <p className="mt-1 text-2xl font-bold text-amber-700">{ready}</p>
        </div>
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div className="flex items-center gap-2">
            <Package className="h-5 w-5 text-blue-600" />
            <span className="text-sm text-gray-600">{t('stats.harvested')}</span>
          </div>
          <p className="mt-1 text-2xl font-bold text-blue-700">{totalHarvested}</p>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        <button onClick={() => setTab('seedlings')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'seedlings' ? 'border-green-600 text-green-700 bg-green-50' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}>
          <Sprout className="inline h-4 w-4 mr-1" />{t('tabs.seedlings')} ({batches.length})
        </button>
        <button onClick={() => setTab('harvests')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'harvests' ? 'border-amber-500 text-amber-700 bg-amber-50' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}>
          <Scissors className="inline h-4 w-4 mr-1" />{t('tabs.harvests')} ({harvests.length})
        </button>
        {tab === 'seedlings' && (
          <div className="ml-auto flex items-center gap-1">
            <Filter className="h-3.5 w-3.5 text-gray-400" />
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="rounded border border-gray-200 px-2 py-1 text-xs">
              <option value="">{t('filter.all')}</option>
              <option value="growing">{t('filter.growing')}</option>
              <option value="ready">{t('filter.ready')}</option>
              <option value="harvested">{t('filter.harvested')}</option>
              <option value="failed">{t('filter.failed')}</option>
            </select>
          </div>
        )}
      </div>

      {showAdd && (
        <AddBatchForm
          offices={offices}
          racks={racks}
          userRole={userRole || 'staff'}
          lockedOfficeId={lockedOfficeId ?? null}
          onSaved={() => { setShowAdd(false); setSuccessMsg(t('messages.seedlingSuccess')); fetchData(); setTimeout(() => setSuccessMsg(''), 3000) }}
        />
      )}

      {loading ? (
        <div className="text-gray-400 text-sm">Loading...</div>
      ) : tab === 'seedlings' ? (
        batches.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-gray-400">
            <Sprout className="mx-auto h-8 w-8 mb-2" />
            <p>{t('messages.noSeedlings')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {batches.map(batch => {
              const days = daysSince(batch.seeded_at)
              const progress = Math.min(100, Math.round((days / batch.expected_harvest_days) * 100))
              return (
                <div key={batch.id} className="rounded-xl border border-border bg-white p-4 hover:shadow-sm transition-shadow">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div className={`mt-0.5 flex h-8 w-8 items-center justify-center rounded-full text-white text-xs font-bold ${statusDotMap[batch.status]}`}>
                        <Sprout className="h-4 w-4" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-medium text-gray-800">{ct(batch.variety)}</h4>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColorMap[batch.status]}`}>
                            {t(`status.${batch.status}`)}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {batch.quantity}{ct(batch.unit)}
                          {batch.rack_name && ` · ${ct(batch.rack_name)}`}
                          {batch.office_name && ` · ${ct(batch.office_name)}`}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {t('messages.seededAt')}: {formatDate(batch.seeded_at)} · {t('messages.dayNum')} {days} {t('harvest.day')} / {t('harvest.expected')} {batch.expected_harvest_days} {t('harvest.day')}
                        </p>
                        {batch.notes && <p className="text-xs text-gray-400 mt-0.5 italic">{ct(batch.notes)}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {batch.status !== 'harvested' && (
                        <button onClick={() => setHarvestBatch(batch)}
                          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1 text-xs text-amber-700 hover:bg-amber-100 flex items-center gap-1">
                          <Scissors className="h-3 w-3" />{t('actions.harvest')}
                        </button>
                      )}
                      {batch.status === 'growing' && days >= batch.expected_harvest_days * 0.8 && (
                        <button onClick={async () => {
                          try {
                          await apiFetch(`/crop-batches/${batch.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ status: 'ready' }),
                          })
                          } catch (err: any) { alert(t('messages.updateFailed') + (err.message || '')) }
                          fetchData()
                        }}
                          className="rounded-lg border border-green-300 bg-green-50 px-2 py-1 text-[10px] text-green-700 hover:bg-green-100">
                          {t('actions.markReady')}
                        </button>
                      )}
                      <button onClick={async () => {
                          if (!confirm(t('actions.confirmDelete'))) return
                          try {
                          await apiFetch(`/crop-batches/${batch.id}`, { method: 'DELETE' })
                          } catch (err: any) { alert(t('messages.deleteFailed') + (err.message || '')) }
                          fetchData()
                        }}
                          className="rounded p-1 text-gray-300 hover:text-red-400">
                          <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                  </div>
                  <div className="mt-3 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        progress >= 100 ? 'bg-amber-500' : progress >= 80 ? 'bg-green-400' : 'bg-green-300'
                      }`}
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )
      ) : (
        harvests.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-amber-200 bg-amber-50/50 p-12 text-center">
            <Scissors className="mx-auto h-10 w-10 mb-3 text-amber-300" />
            <p className="text-amber-600 font-medium">{t('messages.noHarvests')}</p>
            <p className="text-xs text-amber-400 mt-2">{t('messages.noHarvestsHint')}</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-gray-50 text-left text-xs text-gray-500">
                  <th className="px-4 py-2">{t('table.date')}</th>
                  <th className="px-4 py-2">{t('table.variety')}</th>
                  <th className="px-4 py-2">{t('table.quantity')}</th>
                  <th className="px-4 py-2">{t('table.quality')}</th>
                  <th className="px-4 py-2">{t('table.rack')}</th>
                  <th className="px-4 py-2">{t('table.office')}</th>
                  <th className="px-4 py-2">{t('table.notes')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {harvests.map(h => (
                  <tr key={h.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 text-gray-600">{formatDate(h.harvested_at)}</td>
                    <td className="px-4 py-2.5 font-medium text-gray-800">{ct(h.variety || '-')}</td>
                    <td className="px-4 py-2.5">{h.quantity}{ct(h.unit)}</td>
                    <td className={`px-4 py-2.5 font-medium ${qualityColorMap[h.quality] || ''}`}>
                      {t(`harvest.quality${h.quality.charAt(0).toUpperCase() + h.quality.slice(1)}`)}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500">{ct(h.rack_name || '-')}</td>
                    <td className="px-4 py-2.5 text-gray-500">{ct(h.office_name || '-')}</td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">{ct(h.notes || '-')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {harvestBatch && (
        <HarvestModal batch={harvestBatch} onSaved={(msg) => { setSuccessMsg(msg); fetchData(); setTimeout(() => setSuccessMsg(''), 3000) }} onClose={() => setHarvestBatch(null)} />
      )}

      <CropCalendar batches={batches} />
    </div>
  )
}

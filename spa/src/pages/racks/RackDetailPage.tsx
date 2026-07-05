import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useOffices } from '../../hooks/useOffices'
import { useRacks, useRackVegetables, useRackEnvironment } from '../../hooks/useRacks'
import { Plus, Edit2, Trash2, ArrowLeft, Thermometer, Droplets, Sun, Layers, Sprout, MessageCircle, Send, X } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import type { Rack } from '../../types'

export default function RackDetailPage() {
  const { officeId } = useParams<{ officeId: string }>()
  const navigate = useNavigate()
  const { offices } = useOffices()
  const { racks, loading, createRack, updateRack, deleteRack, refetch: refetchRacks } = useRacks(officeId ? Number(officeId) : undefined)
  const { t } = useTranslation()

  const office = offices.find((o) => o.id === Number(officeId))

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Rack | null>(null)
  const [form, setForm] = useState({ name: '', location: '', layer_count: 3, device_id: '' })
  const [expandedRack, setExpandedRack] = useState<number | null>(null)

  const openCreate = () => {
    setEditing(null)
    setForm({ name: '', location: '', layer_count: 3, device_id: '' })
    setShowForm(true)
  }

  const openEdit = (rack: Rack) => {
    setEditing(rack)
    setForm({ name: rack.name, location: rack.location, layer_count: rack.layer_count, device_id: rack.device_id || '' })
    setShowForm(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const payload = { ...form, office_id: Number(officeId), device_id: form.device_id || null }
    if (editing) {
      await updateRack(editing.id, payload)
    } else {
      await createRack(payload)
    }
    setShowForm(false)
  }

  const handleDelete = async (id: number) => {
    if (confirm(t('racks.deleteConfirm', 'Delete?') || 'Delete?')) {
      await deleteRack(id)
    }
  }

  if (loading) return <div className="text-gray-400">{t('common.loading')}</div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/racks')} className="rounded-lg p-1.5 hover:bg-gray-100">
            <ArrowLeft className="h-5 w-5 text-gray-500" />
          </button>
          <div>
            <h2 className="text-xl font-bold">{office?.name || t('racks.allOffices')}</h2>
            {office && <p className="text-sm text-gray-500">{office.contact_person} · {office.contact_phone}</p>}
          </div>
        </div>
        <button onClick={openCreate} className="flex items-center gap-1.5 rounded-lg bg-[#00a65a] px-3 py-1.5 text-sm text-white hover:bg-[#00954f]">
          <Plus className="h-4 w-4" />{t('racks.addRack')}
        </button>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-semibold">{editing ? t('racks.editRack') : t('racks.addRack')}</h3>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">{t('racks.rackName')}</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00a65a]" required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">{t('racks.location')}</label>
                  <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00a65a]" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">{t('racks.layerCount')}</label>
                  <input type="number" min={1} max={10} value={form.layer_count} onChange={(e) => setForm({ ...form, layer_count: Number(e.target.value) })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00a65a]" />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">{t('racks.linkedDevice')}</label>
                <input value={form.device_id} onChange={(e) => setForm({ ...form, device_id: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00a65a]" placeholder="WSD-001" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">{t('common.cancel')}</button>
                <button type="submit" className="rounded-lg bg-[#00a65a] px-4 py-2 text-sm text-white hover:bg-[#00954f]">{editing ? t('common.save') : t('racks.addRack')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {racks.length === 0 ? (
        <div className="rounded-xl border border-border bg-white p-8 text-center">
          <Layers className="mx-auto h-12 w-12 text-gray-300 mb-3" />
          <p className="text-sm font-medium text-gray-500">{t('racks.noRacks')}</p>
          <p className="text-xs text-gray-400 mt-1">{t('racks.addRackDesc')}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {racks.map((rack) => (
            <RackCard
              key={rack.id}
              rack={rack}
              office={office}
              expanded={expandedRack === rack.id}
              onToggle={() => setExpandedRack(expandedRack === rack.id ? null : rack.id)}
              onEdit={() => openEdit(rack)}
              onDelete={() => handleDelete(rack.id)}
              onRefresh={refetchRacks}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function RackCard({ rack, office, expanded, onToggle, onEdit, onDelete, onRefresh }: {
  rack: Rack; office: { whatsapp_number?: string; name?: string } | undefined; expanded: boolean;
  onToggle: () => void; onEdit: () => void; onDelete: () => void; onRefresh: () => void;
}) {
  const { t } = useTranslation()
  const { vegetables, loading: vegLoading, addVegetable, updateVegetable, deleteVegetable } = useRackVegetables(rack.id)
  const { records: envRecords, addRecord } = useRackEnvironment(rack.id)
  const latestEnv = envRecords.length > 0 ? envRecords[0] : null
  const [showVegForm, setShowVegForm] = useState(false)
  const [showEnvForm, setShowEnvForm] = useState(false)
  const [showWhatsApp, setShowWhatsApp] = useState(false)
  const [vegForm, setVegForm] = useState<{ variety: string; quantity: number; layer_number: number; planted_at: number }>({ variety: '', quantity: 1, layer_number: 1, planted_at: 0 })

  const handleAddVegetable = async (e: React.FormEvent) => {
    e.preventDefault()
    await addVegetable(vegForm)
    setShowVegForm(false)
    setVegForm({ variety: '', quantity: 1, layer_number: 1, planted_at: 0 })
    onRefresh()
  }

  const [envForm, setEnvForm] = useState({ temperature: '', humidity: '', light_level: '', ph: '', ec: '' })

  const handleAddEnv = async (e: React.FormEvent) => {
    e.preventDefault()
    await addRecord({
      temperature: envForm.temperature ? Number(envForm.temperature) : null,
      humidity: envForm.humidity ? Number(envForm.humidity) : null,
      light_level: envForm.light_level ? Number(envForm.light_level) : null,
      ph: envForm.ph ? Number(envForm.ph) : null,
      ec: envForm.ec ? Number(envForm.ec) : null,
      source: 'manual',
    })
    setShowEnvForm(false)
    setEnvForm({ temperature: '', humidity: '', light_level: '', ph: '', ec: '' })
  }

  const layerMap = new Map<number, typeof vegetables>()
  vegetables.forEach((v) => {
    const layer = layerMap.get(v.layer_number) || []
    layer.push(v)
    layerMap.set(v.layer_number, layer)
  })

  return (
    <div className="rounded-xl border border-border bg-white shadow-sm">
      <div className="flex items-center justify-between p-5 cursor-pointer" onClick={onToggle}>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#e8f5e9]">
            <Layers className="h-5 w-5 text-[#2E7D32]" />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900">{rack.name}</h3>
            <p className="text-xs text-gray-400">{rack.location} · {rack.layer_count} {t('racks.layers', 'layers')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {office?.whatsapp_number && (
            <button onClick={(e) => { e.stopPropagation(); setShowWhatsApp(!showWhatsApp) }}
              className="rounded p-1.5 text-green-500 hover:bg-green-50">
              <MessageCircle className="h-4 w-4" />
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onEdit() }} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <Edit2 className="h-3.5 w-3.5" />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDelete() }} className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border p-5 space-y-4">
          {/* Environment data */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-gray-700">{t('racks.environment')}</h4>
              <button onClick={() => setShowEnvForm(!showEnvForm)} className="flex items-center gap-1 text-xs text-[#00a65a] hover:underline">
                <Plus className="h-3 w-3" />{t('racks.manual')}
              </button>
            </div>
            <div className="grid grid-cols-5 gap-2">
              <EnvMetric icon={Thermometer} label={t('racks.temperature')} value={latestEnv?.temperature ?? null} unit="°C" color="#E91E63" />
              <EnvMetric icon={Droplets} label={t('racks.humidity')} value={latestEnv?.humidity ?? null} unit="%" color="#2196F3" />
              <EnvMetric icon={Sun} label={t('racks.lightLevel')} value={latestEnv?.light_level ?? null} unit=" lux" color="#FF9800" />
              <EnvMetric icon={Droplets} label="pH" value={latestEnv?.ph ?? null} unit="" color="#4CAF50" />
              <EnvMetric icon={Droplets} label="EC" value={latestEnv?.ec ?? null} unit=" µS/cm" color="#9C27B0" />
            </div>
          </div>

          {showEnvForm && (
            <form onSubmit={handleAddEnv} className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
              <div className="grid grid-cols-5 gap-2">
                <input value={envForm.temperature} onChange={e => setEnvForm({ ...envForm, temperature: e.target.value })}
                  placeholder="°C" className="w-full rounded border border-gray-300 px-2 py-1 text-xs outline-none focus:border-[#00a65a]" />
                <input value={envForm.humidity} onChange={e => setEnvForm({ ...envForm, humidity: e.target.value })}
                  placeholder="%" className="w-full rounded border border-gray-300 px-2 py-1 text-xs outline-none focus:border-[#00a65a]" />
                <input value={envForm.light_level} onChange={e => setEnvForm({ ...envForm, light_level: e.target.value })}
                  placeholder="lux" className="w-full rounded border border-gray-300 px-2 py-1 text-xs outline-none focus:border-[#00a65a]" />
                <input value={envForm.ph} onChange={e => setEnvForm({ ...envForm, ph: e.target.value })}
                  placeholder="pH" className="w-full rounded border border-gray-300 px-2 py-1 text-xs outline-none focus:border-[#00a65a]" />
                <input value={envForm.ec} onChange={e => setEnvForm({ ...envForm, ec: e.target.value })}
                  placeholder="EC" className="w-full rounded border border-gray-300 px-2 py-1 text-xs outline-none focus:border-[#00a65a]" />
              </div>
              <button type="submit" className="rounded bg-[#00a65a] px-3 py-1 text-xs text-white">{t('common.add', 'Add')}</button>
            </form>
          )}

          {/* Vegetables */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-gray-700">{t('racks.vegetables')}</h4>
              <button onClick={() => setShowVegForm(!showVegForm)} className="flex items-center gap-1 text-xs text-[#00a65a] hover:underline">
                <Plus className="h-3 w-3" />{t('racks.addVegetable')}
              </button>
            </div>

            {showVegForm && (
              <form onSubmit={handleAddVegetable} className="rounded-lg border border-gray-200 bg-gray-50 p-3 mb-3 space-y-2">
                <div className="grid grid-cols-4 gap-2">
                  <input value={vegForm.variety} onChange={e => setVegForm({ ...vegForm, variety: e.target.value })}
                    placeholder={t('racks.variety')} className="rounded border border-gray-300 px-2 py-1 text-xs outline-none focus:border-[#00a65a]" required />
                  <input type="number" value={vegForm.quantity} onChange={e => setVegForm({ ...vegForm, quantity: Number(e.target.value) })}
                    placeholder={t('racks.quantity')} className="rounded border border-gray-300 px-2 py-1 text-xs outline-none focus:border-[#00a65a]" />
                  <input type="number" min={1} max={rack.layer_count} value={vegForm.layer_number}
                    onChange={e => setVegForm({ ...vegForm, layer_number: Number(e.target.value) })}
                    placeholder={t('racks.layer', 'Layer')} className="rounded border border-gray-300 px-2 py-1 text-xs outline-none focus:border-[#00a65a]" />
                  <input type="date" value={vegForm.planted_at}
                    onChange={e => setVegForm({ ...vegForm, planted_at: e.target.value ? Math.floor(new Date(e.target.value).getTime() / 1000) : 0 })}
                    className="rounded border border-gray-300 px-2 py-1 text-xs outline-none focus:border-[#00a65a]" />
                </div>
                <button type="submit" className="rounded bg-[#00a65a] px-3 py-1 text-xs text-white">{t('common.add', 'Add')}</button>
              </form>
            )}

            {vegLoading ? <p className="text-xs text-gray-400">{t('common.loading')}</p> :
              Array.from({ length: rack.layer_count }, (_, i) => i + 1).map((layer) => (
                <div key={layer} className="mb-2 rounded-lg border border-gray-100 bg-gray-50/50 p-2">
                  <p className="text-xs font-medium text-gray-500 mb-1">{t('racks.layer', { number: layer, defaultValue: 'Layer ' + layer })}</p>
                  {layerMap.has(layer) ? (
                    <div className="flex flex-wrap gap-1.5">
                      {layerMap.get(layer)!.map((v) => (
                        <span key={v.id} className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs border border-gray-200">
                          <Sprout className="h-3 w-3 text-green-500" />
                          {v.variety} ×{v.quantity}
                          <button onClick={() => { deleteVegetable(v.id); onRefresh() }} className="text-gray-400 hover:text-red-500">×</button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[10px] text-gray-400">{t('racks.noVegetables')}</p>
                  )}
                </div>
              ))
            }
          </div>
        </div>
      )}

      {showWhatsApp && (
        <WhatsAppDialog rack={rack} office={office} onClose={() => setShowWhatsApp(false)} />
      )}
    </div>
  )
}

function EnvMetric({ icon: Icon, label, value, unit, color }: {
  icon: React.ElementType; label: string; value: number | null; unit: string; color: string
}) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 p-2 text-center">
      <Icon className="mx-auto h-4 w-4 mb-1" style={{ color }} />
      <p className="text-[10px] text-gray-500">{label}</p>
      <p className="text-sm font-bold text-gray-800">{value !== null ? value + unit : '-'}</p>
    </div>
  )
}

function WhatsAppDialog({ rack, office, onClose }: {
  rack: Rack; office: { whatsapp_number?: string; name?: string } | undefined; onClose: () => void
}) {
  const { t } = useTranslation()
  const [message, setMessage] = useState('')
  const [phone, setPhone] = useState(office?.whatsapp_number || '')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const handleSend = async () => {
    if (!phone || !message) return
    setSending(true)
    try {
      await apiFetch('/api/workbuddy/send-whatsapp', {
        method: 'POST',
        body: JSON.stringify({ phone, message }),
      })
      setSent(true)
      setTimeout(onClose, 1500)
    } catch {
      alert('Failed to send message')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="border-t border-border bg-green-50/50 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-green-600" />
          <span className="text-sm font-medium text-gray-700">
            WhatsApp — {rack.name}
          </span>
        </div>
        <button onClick={onClose} className="rounded p-1 text-gray-400 hover:text-gray-600">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-2">
        <div>
          <label className="block text-[10px] text-gray-500 mb-1">{t('racks.phone', 'Phone')}</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-[#00a65a]"
            placeholder="85291234567" />
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 mb-1">{t('racks.message', 'Message')}</label>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3}
            className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-[#00a65a] resize-none"
            placeholder={t('racks.aboutRack', 'About rack') + ' ' + rack.name + '...'} />
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
            {t('common.cancel')}
          </button>
          <button onClick={handleSend} disabled={sending || !phone || !message}
            className="flex items-center gap-1 rounded-lg bg-[#25D366] px-3 py-1.5 text-xs text-white hover:bg-[#20BD5A] disabled:opacity-50">
            <Send className="h-3 w-3" />
            {sent ? 'Sent!' : sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

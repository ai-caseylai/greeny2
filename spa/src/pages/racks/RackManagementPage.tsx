import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useOffices } from '../../hooks/useOffices'
import { useRacks } from '../../hooks/useRacks'
import { Building2, Plus, Edit2, Trash2, ChevronRight, Warehouse, MessageCircle, Send, X } from 'lucide-react'
import { apiFetch, mgmtApiFetch } from '../../lib/api'
import type { Office } from '../../types'

export default function RackManagementPage() {
  const { offices, loading, createOffice, updateOffice, deleteOffice } = useOffices()
  const { racks } = useRacks()
  const navigate = useNavigate()
  const { t } = useTranslation()

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Office | null>(null)
  const [form, setForm] = useState({ name: '', contact_person: '', contact_phone: '', whatsapp_number: '', notes: '' })
  const [waOffice, setWaOffice] = useState<Office | null>(null)

  const openCreate = () => {
    setEditing(null)
    setForm({ name: '', contact_person: '', contact_phone: '', whatsapp_number: '', notes: '' })
    setShowForm(true)
  }

  const openEdit = (office: Office) => {
    setEditing(office)
    setForm({ name: office.name, contact_person: office.contact_person, contact_phone: office.contact_phone, whatsapp_number: office.whatsapp_number, notes: office.notes })
    setShowForm(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (editing) {
      await updateOffice(editing.id, form)
    } else {
      await createOffice(form)
    }
    setShowForm(false)
  }

  const handleDelete = async (id: number) => {
    if (confirm(t('racks.deleteConfirm', 'Delete?') || 'Delete?')) {
      await deleteOffice(id)
    }
  }

  if (loading) return <div className="text-gray-400">{t('common.loading')}</div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">{t('racks.title')}</h2>
        <button onClick={openCreate} className="flex items-center gap-1.5 rounded-lg bg-[#00a65a] px-3 py-1.5 text-sm text-white hover:bg-[#00954f]">
          <Plus className="h-4 w-4" />{t('racks.addOffice')}
        </button>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-semibold">{editing ? t('racks.editOffice') : t('racks.addOffice')}</h3>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">{t('racks.officeName')}</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00a65a]" required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">{t('racks.contactPerson')}</label>
                  <input value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00a65a]" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">{t('racks.contactPhone')}</label>
                  <input value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00a65a]" />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">{t('racks.whatsappNumber')}</label>
                <input value={form.whatsapp_number} onChange={(e) => setForm({ ...form, whatsapp_number: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00a65a]" placeholder="85291234567" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">{t('racks.notes')}</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00a65a]" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">{t('common.cancel')}</button>
                <button type="submit" className="rounded-lg bg-[#00a65a] px-4 py-2 text-sm text-white hover:bg-[#00954f]">{editing ? t('common.save') : t('racks.addOffice')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {offices.length === 0 ? (
        <div className="rounded-xl border border-border bg-white p-8 text-center">
          <Building2 className="mx-auto h-12 w-12 text-gray-300 mb-3" />
          <p className="text-sm font-medium text-gray-500">{t('racks.noOffices')}</p>
          <p className="text-xs text-gray-400 mt-1">{t('racks.noOfficesDesc')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {offices.map((office) => {
            const officeRacks = racks.filter((r) => r.office_id === office.id)
            return (
              <div key={office.id} className="rounded-xl border border-border bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#e8f5e9]">
                      <Building2 className="h-5 w-5 text-[#2E7D32]" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900">{office.name}</h3>
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs text-gray-400">{office.contact_person} · {office.contact_phone}</p>
                        {office.whatsapp_number && (
                          <button onClick={() => setWaOffice(office)} className="rounded p-0.5 text-green-500 hover:bg-green-50" title={'WhatsApp: ' + office.whatsapp_number}>
                            <MessageCircle className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(office)} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
                      <Edit2 className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => handleDelete(office.id)} className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-sm text-gray-600">
                  <span className="flex items-center gap-1"><Warehouse className="h-3.5 w-3.5" />{officeRacks.length} {t('racks.racks')}</span>
                </div>
                <button
                  onClick={() => navigate('/racks/office/' + office.id)}
                  className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg border border-border py-2 text-sm text-[#00a65a] hover:bg-[#e8f5e9] transition-colors"
                >
                  {t('racks.racks')} <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {waOffice && <WhatsAppDialog office={waOffice} onClose={() => setWaOffice(null)} />}
    </div>
  )
}

function WhatsAppDialog({ office, onClose }: { office: Office; onClose: () => void }) {
  const { t } = useTranslation()
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const handleSend = async () => {
    if (!office.whatsapp_number || !message) return
    setSending(true)
    try {
      await mgmtApiFetch('/api/workbuddy/send-whatsapp', {
        method: 'POST',
        body: JSON.stringify({ phone: office.whatsapp_number, message }),
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-[#25D366]" />
            <span className="font-semibold text-gray-800">WhatsApp</span>
          </div>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>
        <div className="mb-3 rounded-lg bg-gray-50 p-3">
          <p className="text-sm font-medium text-gray-700">{office.name}</p>
          <p className="text-xs text-gray-500">{office.contact_person} · {office.whatsapp_number}</p>
        </div>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#00a65a] resize-none mb-3"
          placeholder="Type your message..." />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">{t('common.cancel')}</button>
          <button onClick={handleSend} disabled={sending || !message}
            className="flex items-center gap-1 rounded-lg bg-[#25D366] px-3 py-1.5 text-sm text-white hover:bg-[#20BD5A] disabled:opacity-50">
            <Send className="h-3.5 w-3.5" />
            {sent ? 'Sent!' : sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

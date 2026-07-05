import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Users, Plus, Trash2, Shield, Building2, Eye, Search, Pencil, Key, X } from 'lucide-react'
import { useOffice } from '../context/OfficeContext'
import { useOffices } from '../hooks/useOffices'
import { useChineseText } from '../hooks/useChineseText'
import { mgmtApiFetch } from '../lib/api'

interface UserRow {
  id: number
  username: string
  display_name: string
  role: 'superadmin' | 'office_admin' | 'staff'
  office_id: number | null
  active: number
  created_at: number
}

const roleIcons = {
  superadmin: Shield,
  office_admin: Building2,
  staff: Eye,
}

const roleColors = {
  superadmin: { color: 'bg-purple-100 text-purple-700 border-purple-200', dot: 'bg-purple-500' },
  office_admin: { color: 'bg-blue-100 text-blue-700 border-blue-200', dot: 'bg-blue-500' },
  staff: { color: 'bg-gray-100 text-gray-700 border-gray-200', dot: 'bg-gray-400' },
}

function EditUserModal({ user, offices, userRole, onClose, onSaved }: {
  user: UserRow
  offices: { id: number; name: string }[]
  userRole: string
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation('users')
  const ct = useChineseText()
  const [form, setForm] = useState({
    display_name: user.display_name || '',
    role: user.role,
    office_id: user.office_id?.toString() || '',
  })
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        display_name: form.display_name,
      }
      if (userRole === 'superadmin') {
        body.role = form.role as any
        body.office_id = form.office_id ? Number(form.office_id) : null
      }
      if (password) {
        body.password = password
      }
      await mgmtApiFetch(`/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      onSaved()
      onClose()
    } catch (err) {
      alert(t('messages.updateFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">{t('editUser')}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('username')}</label>
            <input value={user.username} disabled className="w-full rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('displayName')}</label>
            <input value={form.display_name} onChange={e => setForm({ ...form, display_name: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          </div>
          {userRole === 'superadmin' && (
            <>
              <div>
                <label className="block text-xs text-gray-500 mb-1">{t('role')}</label>
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value as any })}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm">
                  <option value="staff">{t('roles.staff')}</option>
                  <option value="office_admin">{t('roles.officeAdmin')}</option>
                  <option value="superadmin">{t('roles.superadmin')}</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">{t('office')}</label>
                <select value={form.office_id} onChange={e => setForm({ ...form, office_id: e.target.value })}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm">
                  <option value="">-- None --</option>
                  {offices.map(o => (
                    <option key={o.id} value={o.id}>{ct(o.name)}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          <div className="border-t border-gray-100 pt-3">
            <div className="flex items-center gap-2 mb-2">
              <Key className="h-4 w-4 text-amber-500" />
              <span className="text-sm font-medium text-gray-700">{t('resetPassword')}</span>
            </div>
            <div className="flex gap-2">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t('passwordHint')}
                className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <button type="button" onClick={() => setShowPassword(!showPassword)}
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50">
                {showPassword ? t('hide') : t('show')}
              </button>
            </div>
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button onClick={handleSave} disabled={saving}
            className="rounded-lg bg-[#00a65a] px-4 py-2 text-sm text-white hover:bg-[#00954f] disabled:opacity-50">
            {saving ? t('actions.saving') : t('actions.save')}
          </button>
          <button onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
            {t('actions.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function UserManagementPage() {
  const { t } = useTranslation('users')
  const ct = useChineseText()
  const { userRole, lockedOfficeId } = useOffice()
  const { offices } = useOffices()
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [search, setSearch] = useState('')
  const [editingUser, setEditingUser] = useState<UserRow | null>(null)
  const [form, setForm] = useState({
    username: '', password: '', display_name: '', role: 'staff' as string, office_id: '',
  })

  const fetchUsers = useCallback(async () => {
    try {
      const data = await mgmtApiFetch<UserRow[]>('/users')
      setUsers(data)
    } catch { /* */ } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await mgmtApiFetch('/users', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          office_id: form.office_id ? Number(form.office_id) : undefined,
        }),
      })
      setShowAdd(false)
      setForm({ username: '', password: '', display_name: '', role: 'staff', office_id: '' })
      fetchUsers()
    } catch (err: any) {
      alert(t('messages.addFailed') + (err.message || t('messages.unknownError')))
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm(t('messages.confirmDeactivate'))) return
    try {
      await mgmtApiFetch(`/users/${id}`, { method: 'DELETE' })
      fetchUsers()
    } catch (err: any) {
      alert(t('messages.deactivateFailed') + (err.message || t('messages.unknownError')))
    }
  }

  const handleReactivate = async (id: number) => {
    try {
      await mgmtApiFetch(`/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: 1 }),
      })
      fetchUsers()
    } catch (err: any) {
      alert(t('messages.reactivateFailed') + (err.message || t('messages.unknownError')))
    }
  }

  const visibleUsers = users.filter(u => {
    if (search) {
      const s = search.toLowerCase()
      return u.username.toLowerCase().includes(s) || (u.display_name || '').toLowerCase().includes(s)
    }
    return true
  })

  const grouped = {
    superadmin: visibleUsers.filter(u => u.role === 'superadmin'),
    office_admin: visibleUsers.filter(u => u.role === 'office_admin'),
    staff: visibleUsers.filter(u => u.role === 'staff'),
  }

  const officeMap = new Map(offices.map(o => [o.id, o.name]))

  const roleKeyMap: Record<string, string> = {
    superadmin: 'roles.superadmin',
    office_admin: 'roles.officeAdmin',
    staff: 'roles.staff',
  }
  const roleDescKeyMap: Record<string, string> = {
    superadmin: 'roleDesc.superadmin',
    office_admin: 'roleDesc.officeAdmin',
    staff: 'roleDesc.staff',
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-bold">{t('title')}</h2>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">Role Hierarchy: Super Admin &gt; Office Admin &gt; Staff</p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="relative flex-1 sm:flex-none">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-gray-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-full sm:w-48 rounded-lg border border-border pl-8 pr-3 py-1.5 text-sm outline-none focus:border-[#00a65a]" />
          </div>
          <button onClick={() => setShowAdd(!showAdd)}
            className="flex items-center gap-1.5 rounded-lg bg-[#00a65a] px-3 py-1.5 text-sm text-white hover:bg-[#00954f]">
            <Plus className="h-4 w-4" />{t('addUser')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {(['superadmin', 'office_admin', 'staff'] as const).map((role) => {
          const Icon = roleIcons[role]
          const cfg = roleColors[role]
          const count = grouped[role]?.length || 0
          return (
            <div key={role} className={`rounded-xl border-2 p-5 ${cfg.color}`}>
              <div className="flex items-center gap-3 mb-2">
                <Icon className="h-6 w-6" />
                <div>
                  <h3 className="font-bold">{t(roleKeyMap[role])}</h3>
                </div>
                <span className="ml-auto text-2xl font-bold">{count}</span>
              </div>
              <p className="text-xs opacity-70">{t(roleDescKeyMap[role])}</p>
            </div>
          )
        })}
      </div>

      {showAdd && (
        <form onSubmit={handleAdd} className="rounded-xl border border-[#00a65a]/30 bg-[#e8f5e9]/50 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">{t('newUser')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 lg:grid-cols-5">
            <div>
              <label className="block text-[10px] text-gray-500 mb-1">{t('username')}</label>
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" required />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1">{t('password')}</label>
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" required />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1">{t('displayName')}</label>
              <input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1">{t('role')}</label>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm">
                <option value="staff">{t('roles.staff')}</option>
                {userRole === 'superadmin' && <option value="office_admin">{t('roles.officeAdmin')}</option>}
                {userRole === 'superadmin' && <option value="superadmin">{t('roles.superadmin')}</option>}
              </select>
            </div>
            {(userRole === 'superadmin' || form.role !== 'superadmin') && (
              <div>
                <label className="block text-[10px] text-gray-500 mb-1">{t('office')}</label>
                <select value={form.office_id} onChange={(e) => setForm({ ...form, office_id: e.target.value })}
                  className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm">
                  <option value="">-- Select --</option>
                  {offices.filter(o => userRole === 'superadmin' || o.id === lockedOfficeId).map(o => (
                    <option key={o.id} value={o.id}>{ct(o.name)}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="flex gap-2 mt-3">
            <button type="submit" className="rounded bg-[#00a65a] px-4 py-1.5 text-sm text-white hover:bg-[#00954f]">{t('actions.create')}</button>
            <button type="button" onClick={() => setShowAdd(false)} className="rounded border border-gray-300 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50">{t('actions.cancel')}</button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-gray-400 text-sm">Loading...</div>
      ) : (
        (['superadmin', 'office_admin', 'staff'] as const).map((role) => {
          const roleUsers = grouped[role]
          if (roleUsers.length === 0) return null
          const Icon = roleIcons[role]
          const cfg = roleColors[role]
          return (
            <div key={role} className="rounded-xl border border-border bg-white shadow-sm overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-3 border-b border-border bg-gray-50">
                <Icon className="h-4 w-4" style={{ color: cfg.dot.replace('bg-', '') }} />
                <h3 className="text-sm font-semibold text-gray-700">{t(roleKeyMap[role])}</h3>
                <span className="ml-auto text-xs text-gray-400">{roleUsers.length} users</span>
              </div>
              <div className="divide-y divide-border">
                {roleUsers.map((u) => (
                  <div key={u.id} className="flex items-center justify-between px-5 py-3 hover:bg-gray-50">
                    <div className="flex items-center gap-3">
                      <div className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold text-white ${cfg.dot} ${!u.active ? 'opacity-40' : ''}`}>
                        {(u.display_name || u.username).charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className={`text-sm font-medium ${!u.active ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                          {ct(u.display_name || u.username)}
                        </p>
                        <p className="text-[10px] text-gray-400">
                          @{u.username}
                          {u.office_id && ` · ${ct(officeMap.get(u.office_id) || `Office #${u.office_id}`)}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {!u.active && (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] text-red-600">{t('inactive')}</span>
                      )}
                      <button onClick={() => setEditingUser(u)}
                        className="rounded p-1 text-gray-400 hover:text-blue-500">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      {!u.active && (userRole === 'superadmin' || userRole === 'office_admin') && (
                        <button onClick={() => handleReactivate(u.id)}
                          className="rounded-full bg-green-50 px-2 py-0.5 text-[10px] text-green-600 hover:bg-green-100">
                          {t('actions.reactivate')}
                        </button>
                      )}
                      {u.active && (userRole === 'superadmin' || (userRole === 'office_admin' && u.role === 'staff')) && (
                        <button onClick={() => handleDelete(u.id)}
                          className="flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-600 hover:bg-red-100">
                          <Trash2 className="h-3 w-3" />{t('actions.deactivate')}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })
      )}

      {editingUser && (
        <EditUserModal
          user={editingUser}
          offices={offices}
          userRole={userRole || 'staff'}
          onClose={() => setEditingUser(null)}
          onSaved={fetchUsers}
        />
      )}
    </div>
  )
}

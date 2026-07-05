import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import type { User } from '../types'

interface OfficeContextValue {
  selectedOfficeId: number | null
  setSelectedOfficeId: (id: number | null) => void
  lockedOfficeId: number | null | undefined // undefined = not loaded, null = superadmin (free), number = locked
  userRole: string | null
}

const OfficeContext = createContext<OfficeContextValue>({
  selectedOfficeId: null,
  setSelectedOfficeId: () => {},
  lockedOfficeId: undefined,
  userRole: null,
})

const STORAGE_KEY = 'greeny-selected-office'

export function OfficeProvider({ children }: { children: ReactNode }) {
  const [selectedOfficeId, setSelectedOfficeId] = useState<number | null>(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? Number(saved) : 9
  })

  // Read user from localStorage to determine role and office
  const getUser = (): User | null => {
    try {
      const stored = localStorage.getItem('user')
      return stored ? JSON.parse(stored) : null
    } catch { return null }
  }

  const user = getUser()
  const userRole = user?.role ?? null

  // superadmin can pick any office (lockedOfficeId = null)
  // office_admin and staff are locked to their office
  const lockedOfficeId: number | null | undefined =
    !user ? undefined :
    user.role === 'superadmin' ? null :
    user.office_id ?? undefined

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(selectedOfficeId ?? ''))
  }, [selectedOfficeId])

  // If locked to a specific office, always use that
  const effectiveOfficeId = lockedOfficeId != null ? lockedOfficeId : selectedOfficeId

  return (
    <OfficeContext.Provider value={{ selectedOfficeId: effectiveOfficeId, setSelectedOfficeId, lockedOfficeId, userRole }}>
      {children}
    </OfficeContext.Provider>
  )
}

export function useOffice() {
  return useContext(OfficeContext)
}

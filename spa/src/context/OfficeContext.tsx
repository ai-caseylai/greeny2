import { createContext, useContext, type ReactNode } from 'react'

interface OfficeContextValue {
  selectedOfficeId: null
  setSelectedOfficeId: (_id: number | null) => void
  lockedOfficeId: null
  userRole: string | null
}

const OfficeContext = createContext<OfficeContextValue>({
  selectedOfficeId: null,
  setSelectedOfficeId: () => {},
  lockedOfficeId: null,
  userRole: null,
})

export function OfficeProvider({ children }: { children: ReactNode }) {
  const getUser = () => {
    try {
      const stored = sessionStorage.getItem('user')
      return stored ? JSON.parse(stored) : null
    } catch { return null }
  }

  const user = getUser()
  const userRole = user?.role ?? null

  return (
    <OfficeContext.Provider value={{
      selectedOfficeId: null,
      setSelectedOfficeId: () => {},
      lockedOfficeId: null,
      userRole,
    }}>
      {children}
    </OfficeContext.Provider>
  )
}

export function useOffice() {
  return useContext(OfficeContext)
}

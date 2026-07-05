import { useState, useCallback } from 'react'
import { apiFetch, setToken, clearToken, getToken } from '../lib/api'
import type { User, LoginResponse } from '../types'

export function useAuth() {
  const [user, setUser] = useState<User | null>(() => {
    const stored = sessionStorage.getItem('user')
    return stored ? JSON.parse(stored) : null
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const login = useCallback(async (username: string, password: string) => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      })
      setToken(data.token)
      sessionStorage.setItem('user', JSON.stringify(data.user))
      setUser(data.user)
      return data
    } catch (err: any) {
      setError(err.message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  const logout = useCallback(() => {
    clearToken()
    sessionStorage.removeItem('user')
    setUser(null)
  }, [])

  const isLoggedIn = !!getToken()

  return { user, loading, error, login, logout, isLoggedIn }
}

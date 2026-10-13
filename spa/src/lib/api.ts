const API_BASE = 'https://iot-hub.ai-caseylai.workers.dev'

export function getToken(): string | null {
  return sessionStorage.getItem('token')
}

export function setToken(token: string) {
  sessionStorage.setItem('token', token)
}

export function clearToken() {
  sessionStorage.removeItem('token')
  sessionStorage.removeItem('user')
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers, cache: 'no-store' })

  if (res.status === 401) {
    clearToken()
    if (window.location.pathname !== '/login') {
      window.location.href = '/login'
    }
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(body.error || `HTTP ${res.status}`)
  }

  return res.json()
}

// Management API — uses Pages Functions on same domain (for rack/crop/user management)
export async function mgmtApiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  // Normalise the path. Several call sites pass '/users' or '/crop-batches'
  // without the '/api' prefix; those requests never reach the Functions router,
  // so Pages answered with the SPA fallback (HTTP 200 + index.html) and
  // `res.json()` threw "Unexpected token '<'" — the users/crops pages were
  // either always empty or showed that error. One place fixes all call sites.
  const url = path.startsWith('/api/') ? path : '/api' + (path.startsWith('/') ? path : '/' + path)
  const res = await fetch(url, { ...options, headers, cache: 'no-store' })
  if (res.status === 401) { clearToken(); if (window.location.pathname !== '/login') window.location.href = '/login'; throw new Error('Unauthorized') }
  if (!res.ok) { const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })); throw new Error(body.error || `HTTP ${res.status}`) }
  return res.json()
}

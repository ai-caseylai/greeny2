import { useState, useEffect, useRef } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { useToast } from '../components/Toast'
import { Wifi, Wrench, Info, Search, Lock, Unlock, CheckCircle, XCircle, Loader2, WifiOff } from 'lucide-react'

// ── Reusable layout primitives (from Casey's design) ──

function SettingsSection({ title, icon: Icon, children }: {
  title: string; icon: React.ElementType; children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-white shadow-sm">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-border">
        <Icon className="h-4 w-4 text-[#00a65a]" />
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      </div>
      <div className="p-5 space-y-4">{children}</div>
    </div>
  )
}

// ── WiFi network interface ──

interface WifiNetwork {
  ssid: string
  rssi: number
  enc: number  // 0 = open, > 0 = encrypted
}

// ── SettingsPage ──

export default function SettingsPage() {
  const firstDeviceId = 'esp32-sensor'
  const { connected: wsConnected, wifiNetworks, wifiScanning, wifiAck, sendCommand } = useWebSocket(firstDeviceId)
  const toast = useToast()

  const [selectedSsid, setSelectedSsid] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [scanRequested, setScanRequested] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [wifiStatus, setWifiStatus] = useState<{ success: boolean; message: string } | null>(null)

  // Maintenance thresholds — controlled inputs with localStorage persistence
  const [thresholds, setThresholds] = useState(() => {
    try {
      const stored = localStorage.getItem('greeny-thresholds')
      if (stored) return JSON.parse(stored)
    } catch {}
    return { phMin: '5.5', phMax: '7.5', ecMax: '2000', tempMin: '18', tempMax: '28' }
  })

  const updateThreshold = (key: string, value: string) => {
    setThresholds((prev: typeof thresholds) => ({ ...prev, [key]: value }))
  }

  const handleScan = () => {
    setSelectedSsid(null)
    setScanRequested(true)
    const sent = sendCommand({ command: 'wifi_scan' })
    if (!sent) {
      // WS not connected — show failure after brief delay
      setTimeout(() => setScanRequested(false), 1500)
    } else {
      // Timeout fallback if wifi_list never arrives
      setTimeout(() => setScanRequested(false), 10000)
    }
  }

  // Clear scanRequested + toast when networks arrive
  useEffect(() => {
    if (wifiNetworks.length > 0) {
      setScanRequested(false)
      toast.addToast(`Found ${wifiNetworks.length} network${wifiNetworks.length === 1 ? '' : 's'}`, 'warning')
    }
  }, [wifiNetworks])

  // Toast on connection result + clear timeout
  useEffect(() => {
    if (!wifiAck) return
    clearTimeout(connectTimeoutRef.current)
    setConnecting(false)
    setWifiStatus({ success: wifiAck.success, message: wifiAck.message })
    if (wifiAck.success) {
      setSelectedSsid(null)
      setPassword('')
      toast.addToast(`Connected to ${wifiAck.message}`, 'warning')
    } else {
      toast.addToast(`Connection failed: ${wifiAck.message}`, 'critical')
    }
    const id = setTimeout(() => setWifiStatus(null), 6000)
    return () => clearTimeout(id)
  }, [wifiAck])

  const connectStartedAtRef = useRef<number>(0)
  const connectTimeoutRef = useRef<number>(0)

  const handleConnect = () => {
    if (!selectedSsid) return
    setConnecting(true)
    setWifiStatus(null)
    connectStartedAtRef.current = Date.now()
    sendCommand({ command: 'wifi_set', params: { ssid: selectedSsid, pass: password } })
    // 20s timeout. ESP32 drops WiFi to reconnect → WS dies → ack lost.
    // Fallback: if WS reconnected within 20s, treat as success.
    connectTimeoutRef.current = window.setTimeout(() => {
      setConnecting(false)
      // wsConnected is the hook's live connection state — if it came back, device reconnected
      if (wsConnected) {
        setWifiStatus({ success: true, message: `Connected to ${selectedSsid}` })
        setSelectedSsid(null)
        setPassword('')
        toast.addToast(`Reconnected — telemetry resumed`, 'warning')
      } else {
        setWifiStatus({ success: false, message: 'Device did not reconnect. Check credentials or signal.' })
        toast.addToast('WiFi switch failed — device offline', 'critical')
      }
    }, 20000)
  }

  const cancelConnect = () => {
    clearTimeout(connectTimeoutRef.current)
    setConnecting(false)
    setWifiStatus({ success: false, message: 'Cancelled' })
  }

  const handleSaveThresholds = async () => {
    setSaving(true)
    setSaved(false)
    localStorage.setItem('greeny-thresholds', JSON.stringify(thresholds))
    await new Promise(r => setTimeout(r, 600))
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const signalBars = (rssi: number) => {
    if (rssi > -50) return 4
    if (rssi > -60) return 3
    if (rssi > -70) return 2
    if (rssi > -80) return 1
    return 0
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-gray-900">Settings</h2>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* WiFi Configuration */}
        <SettingsSection title="WiFi Configuration" icon={Wifi}>
          {/* Scan button */}
          <button
            onClick={handleScan}
            disabled={scanRequested}
            className="flex items-center gap-2 rounded-lg bg-[#00a65a] px-4 py-2 text-sm text-white hover:bg-[#00954f] disabled:opacity-50 transition-colors"
          >
            {scanRequested ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            {scanRequested ? 'Scanning...' : 'Scan Networks'}
          </button>
          {!wsConnected && (
            <p className="text-[10px] text-amber-600 flex items-center gap-1"><WifiOff className="h-3 w-3" /> WebSocket disconnected — check System Info below</p>
          )}

          {/* Scan status */}
          {scanRequested && (
            <div className="flex items-center gap-2 text-xs text-blue-600 bg-blue-50 rounded-lg px-3 py-2">
              <Wifi className="h-3.5 w-3.5 animate-pulse" />
              Scanning nearby networks...
            </div>
          )}

          {/* Results summary */}
          {!scanRequested && wifiNetworks.length > 0 && (
            <p className="text-xs text-gray-500">{wifiNetworks.length} network{wifiNetworks.length === 1 ? '' : 's'} found &mdash; sorted by signal strength</p>
          )}

          {/* Network list */}
          {wifiNetworks.length > 0 && (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {wifiNetworks
                .sort((a, b) => b.rssi - a.rssi)
                .map(n => {
                  const bars = signalBars(n.rssi)
                  const isSelected = selectedSsid === n.ssid
                  return (
                    <button
                      key={n.ssid}
                      onClick={() => { setSelectedSsid(isSelected ? null : n.ssid); setPassword(''); setWifiStatus(null) }}
                      className={`w-full flex items-center gap-3 rounded-lg border px-3 py-2 text-sm text-left transition-colors ${
                        isSelected
                          ? 'border-[#00a65a] bg-green-50'
                          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <span className="text-xs text-gray-400 w-8 text-right">{n.rssi} dBm</span>
                      <span className="flex gap-0.5">
                        {[1, 2, 3, 4].map(i => (
                          <span key={i} className={`w-1 rounded-sm ${i <= bars ? 'bg-gray-700' : 'bg-gray-300'}`}
                            style={{ height: `${i * 3}px` }} />
                        ))}
                      </span>
                      <span className="flex-1 font-medium text-gray-800">{n.ssid}</span>
                      {n.enc > 0 ? <Lock className="h-3 w-3 text-gray-400" /> : <Unlock className="h-3 w-3 text-gray-300" />}
                    </button>
                  )
                })}
            </div>
          )}

          {/* No networks yet */}
          {!scanRequested && wifiNetworks.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-2">
              <Search className="h-3.5 w-3.5" />
              No networks found. Click "Scan Networks" above to search for nearby WiFi.
            </div>
          )}

          {/* Password input + Connect button (when network selected) */}
          {selectedSsid && (
            <div className="space-y-3 pt-2 border-t border-gray-100">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Password for {selectedSsid}</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleConnect() }}
                  placeholder="Enter WiFi password"
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-[#00a65a] focus:ring-1 focus:ring-[#00a65a]/20"
                  autoFocus
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleConnect}
                  disabled={connecting || !password}
                  className="flex items-center gap-2 rounded-lg bg-[#00a65a] px-4 py-2 text-sm text-white hover:bg-[#00954f] disabled:opacity-50 transition-colors"
                >
                  {connecting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Wifi className="h-4 w-4" />
                  )}
                  {connecting ? 'Connecting...' : 'Connect'}
                </button>
                {connecting && (
                  <button
                    onClick={cancelConnect}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Status feedback */}
          {wifiStatus && (
            <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
              wifiStatus.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
            }`}>
              {wifiStatus.success ? <CheckCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {wifiStatus.message}
            </div>
          )}
        </SettingsSection>

        {/* Maintenance Thresholds */}
        <SettingsSection title="Maintenance" icon={Wrench}>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">pH Range</span>
              <div className="flex items-center gap-2">
                <input value={thresholds.phMin} onChange={e => updateThreshold('phMin', e.target.value)}
                  className="w-16 rounded-lg border border-border px-2 py-1 text-sm text-center outline-none focus:border-[#00a65a]" />
                <span className="text-gray-400">~</span>
                <input value={thresholds.phMax} onChange={e => updateThreshold('phMax', e.target.value)}
                  className="w-16 rounded-lg border border-border px-2 py-1 text-sm text-center outline-none focus:border-[#00a65a]" />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">EC Max</span>
              <input value={thresholds.ecMax} onChange={e => updateThreshold('ecMax', e.target.value)}
                className="w-20 rounded-lg border border-border px-2 py-1 text-sm text-center outline-none focus:border-[#00a65a]" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Temp Range</span>
              <div className="flex items-center gap-2">
                <input value={thresholds.tempMin} onChange={e => updateThreshold('tempMin', e.target.value)}
                  className="w-16 rounded-lg border border-border px-2 py-1 text-sm text-center outline-none focus:border-[#00a65a]" />
                <span className="text-gray-400">~</span>
                <input value={thresholds.tempMax} onChange={e => updateThreshold('tempMax', e.target.value)}
                  className="w-16 rounded-lg border border-border px-2 py-1 text-sm text-center outline-none focus:border-[#00a65a]" />
              </div>
            </div>
          </div>
          <div className="pt-3 border-t border-border flex items-center gap-2">
            <button
              onClick={handleSaveThresholds}
              disabled={saving}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-white transition-all disabled:opacity-50 ${
                saved
                  ? 'bg-green-500 scale-105'
                  : 'bg-[#00a65a] hover:bg-[#00954f] active:scale-95'
              }`}
            >
              {saving ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving...</>
              ) : saved ? (
                <><CheckCircle className="h-3.5 w-3.5" /> Saved!</>
              ) : (
                'Save'
              )}
            </button>
          </div>
        </SettingsSection>

        {/* System Info */}
        <SettingsSection title="System Info" icon={Info}>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-gray-500">System</span>
              <span className="text-gray-700 font-medium">Greeny Alpha</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">Version</span>
              <span className="text-gray-700">v1.0.0</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">Device</span>
              <span className="text-gray-700">esp32-sensor</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">WS Status</span>
              <span className={`flex items-center gap-1.5 ${wsConnected ? 'text-green-600' : 'text-red-500'}`}>
                <span className={`h-2 w-2 rounded-full ${wsConnected ? 'bg-green-500' : 'bg-red-500'}`} />
                {wsConnected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
          </div>
        </SettingsSection>
      </div>
    </div>
  )
}

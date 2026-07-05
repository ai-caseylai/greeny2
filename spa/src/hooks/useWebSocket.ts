import { useEffect, useRef, useCallback, useState } from 'react'
import { getToken } from '../lib/api'

type MessageHandler = (data: any) => void

export function useWebSocket(deviceId: string | number | null) {
  const wsRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef<Map<string, Set<MessageHandler>>>(new Map())
  const [connected, setConnected] = useState(false)
  const [ledState, setLedState] = useState<boolean | null>(null)
  const [wifiNetworks, setWifiNetworks] = useState<any[]>([])
  const [wifiScanning, setWifiScanning] = useState(false)
  const [wifiAck, setWifiAck] = useState<{ success: boolean; message: string } | null>(null)
  const reconnectTimerRef = useRef<number>(0)

  const connect = useCallback(() => {
    if (!deviceId) return

    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    // Prototype format: token via query param (browsers can't set WS headers)
    const token = getToken()
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : ''
    const wsUrl = `wss://iot-hub.funconnect.workers.dev/dashboard/${deviceId}${tokenParam}`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, 30000)
      ws.addEventListener('close', () => clearInterval(pingInterval), { once: true })
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)

        // Prototype DO sends { type: "state", ph, tds, ec, temp, led, connected, doTs, esp32_ms }
        if (msg.type === 'state') {
          if (typeof msg.led === 'boolean') setLedState(msg.led)
        }

        // WiFi scan results — store in hook state for SettingsPage
        if (msg.type === 'wifi_list') {
          setWifiNetworks(msg.networks || [])
          setWifiScanning(false)
        }

        // WiFi connection result: {status:"ok",ip:"..."} or {status:"error",msg:"..."}
        if (msg.type === 'wifi_ack') {
          setWifiAck({ success: msg.status === 'ok', message: msg.ip || msg.msg || msg.status || '' })
        }

        // Dispatch to registered handlers by type
        const handlers = handlersRef.current.get(msg.type)
        if (handlers) {
          handlers.forEach(handler => handler(msg))
        }
        const wildcard = handlersRef.current.get('*')
        if (wildcard) {
          wildcard.forEach(handler => handler(msg))
        }
      } catch { /* ignore */ }
    }

    ws.onclose = () => {
      setConnected(false)
      wsRef.current = null
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = window.setTimeout(connect, 5000)
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [deviceId])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimerRef.current)
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [connect])

  const on = useCallback((type: string, handler: MessageHandler) => {
    if (!handlersRef.current.has(type)) {
      handlersRef.current.set(type, new Set())
    }
    handlersRef.current.get(type)!.add(handler)
    return () => {
      handlersRef.current.get(type)?.delete(handler)
    }
  }, [])

  const toggleLed = useCallback(async (devId: string, on: boolean): Promise<boolean> => {
    const relay1 = on ? 1 : 0
    const apiBase = 'https://iot-hub.funconnect.workers.dev'

    try {
      const res = await fetch(`${apiBase}/api/relay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ device_id: devId, relay1 }),
      })
      const data = await res.json()
      if (data.ok) {
        setLedState(data.led === true || data.led === 1)
        return data.led === true || data.led === 1
      }
    } catch { /* fall through to WS */ }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ command: 'set_led', state: on, device_id: devId }))
    }

    return on
  }, [])

  const sendRelay = useCallback((deviceId: string, relay1: number, _relay2?: number, _relay3?: number, _relay4?: number) => {
    toggleLed(deviceId, relay1 === 1)
  }, [toggleLed])

  const sendLed = useCallback((deviceId: string, led: number) => {
    toggleLed(deviceId, led === 1)
  }, [toggleLed])

  const sendPhCal = useCallback((_deviceId: string, _phCal: number) => {}, [])

  // Generic command sender — for wifi_scan, wifi_set, etc.
  const sendCommand = useCallback((data: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
      return true
    }
    return false
  }, [])

  return { connected, ledState, wifiNetworks, wifiScanning, wifiAck, on, sendRelay, sendPhCal, sendLed, toggleLed, sendCommand }
}

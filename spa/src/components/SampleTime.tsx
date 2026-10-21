import { useEffect, useState } from 'react'
import type { Telemetry } from '../types'
import { formatSampleTime } from '../lib/telemetry'

export default function SampleTime({ reading }: { reading: Telemetry | null | undefined }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 5000); return () => window.clearInterval(timer) }, [])
  const stamp = reading?.utc_ms
  const stale = !stamp || now - stamp > 30000 || stamp - now > 5000
  return <span className={stale ? 'text-amber-700' : 'text-gray-500'}>採樣：{formatSampleTime(reading)} · {!stamp ? '尚無有效採樣時間' : stale ? '讀數已過期' : '最新感測'}</span>
}

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('zh-TW')
}

export function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - (ts > 9999999999 ? ts / 1000 : ts)
  const seconds = diff
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export function severityColor(severity: string): string {
  switch (severity) {
    case 'critical': return 'text-red-700 bg-red-100'
    case 'warning': return 'text-amber-700 bg-amber-100'
    case 'info': return 'text-blue-700 bg-blue-100'
    default: return 'text-gray-700 bg-gray-100'
  }
}

export function statusColor(status: string): string {
  switch (status) {
    case 'online': return 'bg-green-500'
    case 'warning': return 'bg-amber-500'
    case 'alarm': return 'bg-red-500'
    case 'maintenance': return 'bg-blue-500'
    case 'offline': return 'bg-gray-400'
    default: return 'bg-gray-400'
  }
}

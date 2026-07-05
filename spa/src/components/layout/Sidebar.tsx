import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Droplets,
  Cpu,
  Bell,
  Settings,
  X,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { AquaGreenLogo } from '../AquaGreenLogo'

export function Sidebar({ onNavClick }: { onNavClick?: () => void }) {
  const navItems = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/water-quality', icon: Droplets, label: 'Sensors' },
    { to: '/device-control', icon: Cpu, label: 'Devices' },
    { to: '/alerts', icon: Bell, label: 'Alerts' },
    { to: '/settings', icon: Settings, label: 'Settings' },
  ]

  return (
    <aside className="h-full w-60 bg-[#1B5E20] flex flex-col">
      <div className="flex h-14 items-center justify-between px-4 border-b border-white/10">
        <div className="flex items-center">
          <AquaGreenLogo className="h-9 w-auto" white />
        </div>
        <button onClick={onNavClick} className="lg:hidden text-green-300 hover:text-white p-1">
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            onClick={onNavClick}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors',
                isActive
                  ? 'bg-[#2E7D32] text-white font-medium'
                  : 'text-green-200 hover:bg-white/10 hover:text-white'
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="px-4 pb-3 text-[10px] text-green-400/50">
        Greeny Alpha &middot; Tech For Living
      </div>
    </aside>
  )
}

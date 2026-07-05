import { Bell, Menu } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useNavigate } from 'react-router-dom'
import { useSidebar } from './DashboardLayout'

export function Header() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { setOpen } = useSidebar()

  const roleLabel = user?.role === 'superadmin' ? 'SA' : user?.role === 'admin' ? 'AD' : 'ST'

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-white px-4 lg:px-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setOpen(true)}
          className="lg:hidden rounded-lg p-2 hover:bg-gray-100 transition-colors"
        >
          <Menu className="h-5 w-5 text-gray-600" />
        </button>
      </div>
      <div className="flex items-center gap-2 sm:gap-4">
        <button
          onClick={() => navigate('/alerts')}
          className="relative rounded-lg p-2 hover:bg-gray-100 transition-colors"
        >
          <Bell className="h-5 w-5 text-gray-600" />
        </button>
        <div className="flex items-center gap-2 text-sm">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#e8f5e9] text-[#1B5E20] text-xs font-bold">
            {(user?.display_name || user?.username || 'A')[0].toUpperCase()}
          </div>
          <span className="text-gray-700 hidden sm:inline">{user?.display_name || user?.username || ''}</span>
          <span className="text-[10px] text-gray-400 hidden md:inline">{roleLabel}</span>
        </div>
        <button
          onClick={handleLogout}
          className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
        >
          <span className="hidden sm:inline">Logout</span>
          <span className="sm:hidden text-xs">Out</span>
        </button>
      </div>
    </header>
  )
}

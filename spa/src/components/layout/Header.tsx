import { Bell, Menu, Globe } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../hooks/useAuth'
import { useNavigate } from 'react-router-dom'
import { useSidebar } from './DashboardLayout'

export function Header() {
  const { t, i18n } = useTranslation()
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { setOpen } = useSidebar()

  const roleLabel = user?.role === 'superadmin' ? t('header.roles.SA') : user?.role === 'admin' ? t('header.roles.AD') : t('header.roles.ST')

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const cycleLang = () => {
    const langs = ['en', 'zh-TW', 'zh-CN']
    const idx = langs.indexOf(i18n.language)
    const next = langs[(idx + 1) % langs.length]
    i18n.changeLanguage(next)
  }

  const langLabel = i18n.language === 'zh-TW' ? '繁' : i18n.language === 'zh-CN' ? '简' : 'EN'

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-white px-4 lg:px-6">
      <div className="flex items-center gap-3">
        <button onClick={() => setOpen(true)} className="lg:hidden rounded-lg p-2 hover:bg-gray-100 transition-colors">
          <Menu className="h-5 w-5 text-gray-600" />
        </button>
      </div>
      <div className="flex items-center gap-2 sm:gap-4">
        <button onClick={cycleLang}
          className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors">
          <Globe className="h-3.5 w-3.5" />
          {langLabel}
        </button>
        <button onClick={() => navigate('/alerts')} className="relative rounded-lg p-2 hover:bg-gray-100 transition-colors">
          <Bell className="h-5 w-5 text-gray-600" />
        </button>
        <div className="flex items-center gap-2 text-sm">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#e8f5e9] text-[#1B5E20] text-xs font-bold">
            {(user?.display_name || user?.username || 'A')[0].toUpperCase()}
          </div>
          <span className="text-gray-700 hidden sm:inline">{user?.display_name || user?.username || ''}</span>
          <span className="text-[10px] text-gray-400 hidden md:inline">{roleLabel}</span>
        </div>
        <button onClick={handleLogout}
          className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors">
          <span className="hidden sm:inline">{t('header.logout')}</span>
          <span className="sm:hidden text-xs">{t('header.logoutShort')}</span>
        </button>
      </div>
    </header>
  )
}

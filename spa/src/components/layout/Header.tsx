import { Bell, Menu, Globe, ChevronDown, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../hooks/useAuth'
import { useNavigate } from 'react-router-dom'
import { useSidebar } from './DashboardLayout'
import { useState, useRef, useEffect } from 'react'

const LANGS = [
  { code: 'en', flag: '🇬🇧', label: 'English' },
  { code: 'zh-TW', flag: '🇭🇰', label: '繁體中文' },
  { code: 'zh-CN', flag: '🇨🇳', label: '简体中文' },
] as const

export function Header() {
  const { t, i18n } = useTranslation()
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { setOpen } = useSidebar()
  const [langOpen, setLangOpen] = useState(false)
  const langRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setLangOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const roleLabel = user?.role === 'superadmin' ? t('header.roles.SA') : user?.role === 'admin' ? t('header.roles.AD') : t('header.roles.ST')

  const currentLang = LANGS.find(l => l.code === i18n.language) || LANGS[0]

  const handleLogout = () => { logout(); navigate('/login') }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-white px-4 lg:px-6">
      <div className="flex items-center gap-3">
        <button onClick={() => setOpen(true)} className="lg:hidden rounded-lg p-2 hover:bg-gray-100 transition-colors">
          <Menu className="h-5 w-5 text-gray-600" />
        </button>
      </div>
      <div className="flex items-center gap-2 sm:gap-4">
        {/* Language Dropdown */}
        <div ref={langRef} className="relative">
          <button onClick={() => setLangOpen(!langOpen)}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors">
            <span className="text-sm">{currentLang.flag}</span>
            <ChevronDown className="h-3 w-3" />
          </button>
          {langOpen && (
            <div className="absolute right-0 top-full mt-1 w-40 rounded-lg border border-border bg-white shadow-lg py-1 z-50">
              {LANGS.map(lang => (
                <button key={lang.code}
                  onClick={() => { i18n.changeLanguage(lang.code); setLangOpen(false) }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 transition-colors ${
                    i18n.language === lang.code ? 'text-[#00a65a] font-medium' : 'text-gray-700'
                  }`}>
                  <span className="text-base">{lang.flag}</span>
                  <span className="flex-1 text-left">{lang.label}</span>
                  {i18n.language === lang.code && <Check className="h-3.5 w-3.5" />}
                </button>
              ))}
            </div>
          )}
        </div>
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

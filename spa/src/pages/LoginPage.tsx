import { useTranslation } from 'react-i18next'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { AquaGreenLogo } from '../components/AquaGreenLogo'

export default function LoginPage() {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const { login, loading, error } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await login(username, password)
      navigate('/')
    } catch {
      // error shown in state
    }
  }

  return (
    <div className="flex min-h-screen">
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-between p-12 text-white"
        style={{ background: 'linear-gradient(135deg, #1B5E20 0%, #2E7D32 40%, #4CAF50 100%)' }}
      >
        <div className="flex items-center gap-3">
          <AquaGreenLogo className="h-10 w-auto" white />
        </div>
        <div>
          <h1 className="text-4xl font-bold mb-4">{t('login.title')}</h1>
          <p className="text-green-100 text-lg leading-relaxed whitespace-pre-line">
            {t('login.subtitle')}
          </p>
          <div className="mt-8 flex gap-8">
            <div><div className="text-3xl font-bold">4</div><div className="text-green-200 text-sm">{t('login.sensors')}</div></div>
            <div><div className="text-3xl font-bold">24/7</div><div className="text-green-200 text-sm">{t('login.monitoring')}</div></div>
            <div><div className="text-3xl font-bold">4</div><div className="text-green-200 text-sm">{t('login.parameters')}</div></div>
          </div>
        </div>
        <div className="text-green-200 text-sm">{t('login.domain')}</div>
      </div>

      <div className="flex w-full lg:w-1/2 items-center justify-center p-8 bg-gray-50">
        <div className="w-full max-w-sm">
          <div className="flex items-center justify-center mb-2 lg:hidden">
            <AquaGreenLogo className="h-10 w-auto" />
          </div>
          <h2 className="text-2xl font-bold text-center mb-1 text-gray-900">{t('login.welcomeBack')}</h2>
          <p className="text-center text-gray-500 mb-8">{t('login.signIn')}</p>
          {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{t('login.invalidCredentials')}</div>}
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">{t('login.username')}</label>
              <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-[#00a65a] focus:ring-2 focus:ring-[#00a65a]/20"
                placeholder={t('login.usernamePlaceholder')} required />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">{t('login.password')}</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-[#00a65a] focus:ring-2 focus:ring-[#00a65a]/20"
                placeholder={t('login.passwordPlaceholder')} required />
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="remember" checked={remember} onChange={(e) => setRemember(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 accent-[#00a65a]" />
              <label htmlFor="remember" className="text-sm text-gray-600">{t('login.rememberMe')}</label>
            </div>
            <button type="submit" disabled={loading}
              className="w-full rounded-lg bg-[#00a65a] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#00954f] disabled:opacity-50">
              {loading ? t('login.loggingIn') : t('login.login')}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

import { useState, createContext, useContext } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { OfficeProvider } from '../../context/OfficeContext'
import { ChatWidget } from '../ChatWidget'
import { ToastProvider } from '../Toast'

const SidebarContext = createContext<{
  open: boolean
  setOpen: (v: boolean) => void
}>({ open: false, setOpen: () => {} })

export function useSidebar() {
  return useContext(SidebarContext)
}

export function DashboardLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <ToastProvider>
      <SidebarContext.Provider value={{ open: sidebarOpen, setOpen: setSidebarOpen }}>
        <OfficeProvider>
          <div className="min-h-screen bg-background">
            {/* Mobile overlay */}
            {sidebarOpen && (
              <div
                className="fixed inset-0 z-40 bg-black/40 lg:hidden"
                onClick={() => setSidebarOpen(false)}
              />
            )}

            {/* Sidebar: hidden on mobile, visible on lg */}
            <div
              className={`fixed inset-y-0 left-0 z-50 w-60 transform transition-transform duration-200 lg:translate-x-0 ${
                sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            >
              <Sidebar onNavClick={() => setSidebarOpen(false)} />
            </div>

            {/* Main content: no left padding on mobile */}
            <div className="lg:pl-60">
              <Header />
              <main className="p-4 lg:p-6">
                <Outlet />
              </main>
            </div>
          </div>
          <ChatWidget />
        </OfficeProvider>
      </SidebarContext.Provider>
    </ToastProvider>
  )
}

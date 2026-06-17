import { useState, useEffect } from 'react'
import LoginPage from './pages/LoginPage'
import KitchenDisplay from './pages/KitchenDisplay'
import { getToken, getUser, logout } from './services/auth'
import type { KitchenUser } from './services/auth'
import './index.css'

export default function App() {
  const [user, setUser] = useState<KitchenUser | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const token = getToken()
    const u = getUser()
    if (token && u) setUser(u)
    setReady(true)
  }, [])

  function handleLogin(u: KitchenUser) {
    setUser(u)
  }

  function handleLogout() {
    logout()
    setUser(null)
  }

  if (!ready) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="w-14 h-14 rounded-2xl bg-orange-500 flex items-center justify-center shadow-lg shadow-orange-500/40">
          <span className="text-white font-black text-2xl">K</span>
        </div>
      </div>
    )
  }

  if (!user) return <LoginPage onLogin={handleLogin} />
  return <KitchenDisplay user={user} onLogout={handleLogout} />
}

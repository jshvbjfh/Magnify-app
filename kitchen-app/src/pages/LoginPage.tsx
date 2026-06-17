import { useState } from 'react'
import { Loader2, Lock, User, Server, Eye, EyeOff } from 'lucide-react'
import { login } from '../services/auth'
import { getServerUrl } from '../config'
import { useOnline } from '../hooks/useOnline'
import type { KitchenUser } from '../services/auth'

interface Props {
  onLogin: (user: KitchenUser) => void
}

export default function LoginPage({ onLogin }: Props) {
  const { isOnline } = useOnline()
  const [serverUrl, setServerUrl] = useState(getServerUrl)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!serverUrl.trim()) {
      setError('Server URL is required.')
      return
    }
    setLoading(true)
    setError(null)

    try {
      const user = await login(serverUrl.trim(), username, password)
      onLogin(user)
    } catch (err) {
      setError((err as Error).message ?? 'Login failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12 bg-gray-950">
      <div className="w-full max-w-[400px] space-y-4">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl p-8">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4 bg-orange-500 shadow-lg shadow-orange-500/30">
              <span className="text-white font-black text-2xl">K</span>
            </div>
            <h1 className="text-2xl font-bold text-white mb-1">Magnify Kitchen</h1>
            <p className="text-sm text-gray-400">Kitchen Display Terminal</p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2.5">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {!isOnline && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-2.5">
                <p className="text-sm text-amber-400">Device is offline. Connect to the restaurant network first.</p>
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Server URL</label>
              <div className="relative">
                <Server className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                <input
                  type="url"
                  value={serverUrl}
                  onChange={e => setServerUrl(e.target.value)}
                  placeholder="http://192.168.1.10:3000"
                  required
                  className="w-full pl-10 pr-4 py-3 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-600 text-sm focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500/40"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Username</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                <input
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="kitchen@restaurant.com"
                  required
                  autoComplete="username"
                  className="w-full pl-10 pr-4 py-3 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-600 text-sm focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500/40"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
                  className="w-full pl-10 pr-12 py-3 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-600 text-sm focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500/40"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !isOnline}
              className="w-full py-3 bg-orange-500 hover:bg-orange-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Connecting…
                </>
              ) : (
                'Sign In'
              )}
            </button>
          </form>
        </div>
      </div>
    </main>
  )
}

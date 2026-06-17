import { useState } from 'react'
import { Loader2, Lock, Mail, Eye, EyeOff, WifiOff } from 'lucide-react'
import { login } from '../services/auth'
import { useOnline } from '../hooks/useOnline'

interface LoginPageProps {
  onLogin: () => Promise<void> | void
  onOpenLogs?: () => void
}

export default function LoginPage({ onLogin, onOpenLogs }: LoginPageProps) {
  const { isOnline } = useOnline()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [stage, setStage] = useState<{ label: string; progress: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setStage({ label: 'Verifying credentials…', progress: 20 })

    try {
      const user = await login(email, password)

      if (user.role !== 'waiter' && user.role !== 'admin' && user.role !== 'kitchen') {
        setError('This app is for waiter accounts only.')
        setLoading(false)
        setStage(null)
        return
      }

      setStage({ label: 'Opening terminal…', progress: 100 })
      await onLogin()
    } catch (err) {
      setError((err as Error).message ?? 'Login failed')
      setLoading(false)
      setStage(null)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12 relative">
      <div className="absolute inset-0 bg-gradient-to-br from-orange-50 via-white to-rose-100" />
      <div className="absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_top,_rgba(249,115,22,0.16),_transparent_60%)]" />
      <div className="absolute -top-16 right-[-72px] h-56 w-56 rounded-full bg-orange-200/30 blur-3xl" />
      <div className="absolute bottom-0 left-[-72px] h-64 w-64 rounded-full bg-red-200/30 blur-3xl" />

      <div className="relative z-10 w-full max-w-[440px] space-y-4">
        <div className="bg-white/95 backdrop-blur-md border border-white/70 rounded-2xl shadow-2xl p-10 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-5 shadow-lg shadow-orange-500/30 overflow-hidden">
              <img src="/icon.svg" alt="Magnify" className="h-20 w-20 rounded-2xl object-cover" />
            </div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-gray-900 to-gray-700 bg-clip-text text-transparent mb-2">
              Magnify
            </h1>
            <p className="text-sm text-gray-600 font-medium">Waiter Terminal</p>
            <div className="mt-4 inline-flex items-center gap-2 bg-orange-50 text-orange-700 text-xs font-semibold px-4 py-2 rounded-full border border-orange-100">
              <div className="w-1.5 h-1.5 bg-orange-500 rounded-full animate-pulse" />
              Offline-First POS
            </div>
          </div>

          <form onSubmit={onSubmit} className="space-y-6">
            {/* Offline notice — replaces form controls when no internet */}
            {!isOnline && (
              <div className="flex flex-col items-center gap-3 py-4 text-center">
                <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center">
                  <WifiOff className="h-6 w-6 text-amber-600" />
                </div>
                <p className="text-sm font-semibold text-gray-800">Your device is offline, please connect first.</p>
                <p className="text-xs text-gray-500 leading-relaxed">
                  An internet connection is required to sign in for the first time.
                  Once signed in, the app works fully offline.
                </p>
              </div>
            )}
            {/* Fields + submit — hidden when offline */}
            {isOnline && (<>
            {/* Email */}
            <div className="space-y-2">
              <label htmlFor="email" className="block text-sm font-semibold text-gray-700">Email</label>
              <div className="relative group">
                <Mail className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400 group-focus-within:text-orange-500 transition-colors" />
                <input
                  id="email"
                  className="h-12 w-full border border-gray-300 rounded-xl pl-12 pr-4 text-sm bg-white hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all duration-200 placeholder:text-gray-400"
                  type="email"
                  placeholder="your@email.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-2">
              <label htmlFor="password" className="block text-sm font-semibold text-gray-700">Password</label>
              <div className="relative group">
                <Lock className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400 group-focus-within:text-orange-500 transition-colors" />
                <input
                  id="password"
                  className="h-12 w-full border border-gray-300 rounded-xl pl-12 pr-12 text-sm bg-white hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all duration-200 placeholder:text-gray-400"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </div>

            {/* Progress bar */}
            {stage && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-orange-600">{stage.label}</span>
                  <span className="text-xs text-gray-400">{stage.progress}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-orange-500 to-red-500 transition-all duration-500 ease-out"
                    style={{ width: `${stage.progress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="flex items-start gap-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                <span className="font-medium">{error}</span>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700 active:scale-[0.98] text-white py-3.5 text-sm font-semibold shadow-lg shadow-orange-500/40 hover:shadow-xl hover:shadow-orange-500/50 disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100 transition-all duration-200 inline-flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span>{stage?.label ?? 'Signing in…'}</span>
                </>
              ) : (
                <span>Sign in</span>
              )}
            </button>
            </>)}
            {onOpenLogs && (
              <button
                type="button"
                onClick={onOpenLogs}
                className="w-full rounded-xl border border-gray-200 text-gray-600 hover:text-gray-900 hover:bg-gray-50 py-3 text-sm font-medium transition-colors"
              >
                Open startup.log
              </button>
            )}
          </form>
        </div>
      </div>
    </main>
  )
}

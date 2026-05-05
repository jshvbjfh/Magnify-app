'use client'

import { signIn, getSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Loader2, Lock, Mail, Eye, EyeOff } from 'lucide-react'
import { loadServerOwnerSyncConfig, seedOwnerSyncConfigFromLogin } from '@/lib/ownerSyncBrowser'

export default function LoginForm() {
	const router = useRouter()
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [loading, setLoading] = useState(false)
	const [stage, setStage] = useState<{ label: string; progress: number } | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [showPassword, setShowPassword] = useState(false)

	async function loadBootstrapStatus() {
		const res = await fetch('/api/restaurant/bootstrap-status', {
			credentials: 'include',
			cache: 'no-store',
		})
		const payload = await res.json().catch(() => null)
		if (!res.ok) {
			throw new Error(payload?.error || 'Unable to confirm restaurant bootstrap state')
		}
		return payload as { required?: boolean; message?: string | null }
	}

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault()
		setLoading(true)
		setStage({ label: 'Verifying credentials…', progress: 20 })
		setError(null)

		const result = await signIn('credentials', {
			email: email.trim().toLowerCase(),
			password,
			redirect: false
		})
		if (result?.error) {
			setLoading(false)
			setStage(null)
			if (result.error === 'AccountInactive') {
				setError('Your account has been deactivated. Contact Magnify admin to restore access.')
			} else {
				setError('Invalid email or password')
			}
			return
		}
		// Redirect based on business type
		setStage({ label: 'Loading account…', progress: 45 })
		const session = await getSession()
		const role = (session?.user as any)?.role
		if (role === 'admin' || role === 'waiter' || role === 'kitchen') {
			setStage({ label: 'Checking setup…', progress: 65 })
			let bootstrapStatus: { required?: boolean; isLocalFirst?: boolean; message?: string | null } | null = null
			try {
				bootstrapStatus = await loadBootstrapStatus()
			} catch (bootstrapError) {
				// If bootstrap check fails entirely, proceed to the app — the restaurant page will
				// handle the case where bootstrap is genuinely required.
				if (bootstrapError instanceof Error) {
					setLoading(false)
					setStage(null)
					setError(bootstrapError.message)
					return
				}
			}

			// Only call sync/local on local-first desktop (Electron). On the cloud (Vercel) the
			// restaurant data lives in Neon — sync/local does not apply and would always fail.
			if (bootstrapStatus?.isLocalFirst && bootstrapStatus?.required) {
				// Seed credentials NOW so RestaurantBootstrapGate can use them if sync fails and
				// the user is shown the gate screen on a subsequent restart.
				seedOwnerSyncConfigFromLogin({
					email: email.trim().toLowerCase(),
					password,
				})

				setStage({ label: 'Syncing restaurant data…', progress: 80 })
				let syncFailureMessage: string | null = null
				try {
					const res = await fetch('/api/sync/local', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						credentials: 'include',
						// Pass credentials directly — targetUrl is resolved server-side from env
						body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
					})
					const payload = await res.json().catch(() => null)
					if (!res.ok || payload?.ok === false) {
						syncFailureMessage = payload?.message || payload?.error || 'Unable to load restaurant data on this device.'
					}
				} catch {
					syncFailureMessage = 'Unable to load restaurant data on this device. Please check your connection and retry.'
				}

				if (syncFailureMessage) {
					setLoading(false)
					setStage(null)
					setError(syncFailureMessage)
					return
				}

				// Re-check bootstrap status after sync completes
				try {
					const postSyncStatus = await loadBootstrapStatus()
					if (postSyncStatus?.required) {
						setLoading(false)
						setStage(null)
						setError(postSyncStatus.message || 'Unable to load restaurant data on this device. Please retry sync.')
						return
					}
				} catch {
					// Sync succeeded but re-check failed — let the restaurant page decide
				}
			} else if (bootstrapStatus?.required) {
				// Bootstrap required but not local-first — shouldn't happen, but guard anyway
				setLoading(false)
				setStage(null)
				setError(bootstrapStatus.message || 'Unable to load restaurant data on this device. Please retry sync.')
				return
			}
		}
		// Seed sync credentials for all desktop-capable roles so RestaurantBootstrapGate
		// can authenticate on the next restart without prompting for credentials again.
		if (role === 'admin' || role === 'waiter' || role === 'kitchen') {
			try {
				const serverSyncConfig = role === 'admin' ? await loadServerOwnerSyncConfig().catch(() => null) : null
				seedOwnerSyncConfigFromLogin({
					email: email.trim().toLowerCase(),
					password,
					targetUrl: serverSyncConfig?.targetUrl,
					serverConfig: serverSyncConfig,
				})
			} catch {}
		}
		setStage({ label: 'Done!', progress: 100 })
		await new Promise((r) => setTimeout(r, 400))
		router.push('/restaurant')
	}

	return (
		<form onSubmit={onSubmit} className="space-y-6">
			{/* Email Field */}
			<div className="space-y-2">
				<label htmlFor="email" className="block text-sm font-semibold text-gray-700">
					Email
				</label>
				<div className="relative group">
					<Mail className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400 group-focus-within:text-orange-500 transition-colors" />
					<input
						id="email"
						className="h-12 w-full border border-gray-300 rounded-xl pl-12 pr-4 text-sm bg-white hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all duration-200 placeholder:text-gray-400"
						type="email"
						placeholder="you@example.com"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						required
						autoComplete="email"
					/>
				</div>
			</div>

			{/* Password Field */}
			<div className="space-y-2">
				<label htmlFor="password" className="block text-sm font-semibold text-gray-700">
					Password
				</label>
				<div className="relative group">
					<Lock className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400 group-focus-within:text-orange-500 transition-colors" />
					<input
						id="password"
						className="h-12 w-full border border-gray-300 rounded-xl pl-12 pr-12 text-sm bg-white hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all duration-200 placeholder:text-gray-400"
						type={showPassword ? 'text' : 'password'}
						placeholder="••••••••"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						required
						autoComplete="current-password"
					/>
					<button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors">
						{showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
					</button>
				</div>
				<div className="flex justify-end mt-1">
					<a href="/forgot-password" className="text-xs text-orange-600 hover:text-orange-800 hover:underline transition-colors">
						Forgot password?
					</a>
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
			{/* Error Message */}
			{error && (
				<div className="flex items-start gap-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3 animate-in slide-in-from-top-1 duration-300">
					<svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
						<path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
					</svg>
					<span className="font-medium">{error}</span>
				</div>
			)}

			{/* Submit Button */}
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
		</form>
	)
}

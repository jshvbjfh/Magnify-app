'use client'

import { signIn, getSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Loader2, Lock, Mail, Eye, EyeOff } from 'lucide-react'

export default function LoginForm() {
	const router = useRouter()
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [showPassword, setShowPassword] = useState(false)

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault()
		setLoading(true)
		setError(null)

		const result = await signIn('credentials', {
			email,
			password,
			redirect: false
		})

		setLoading(false)
		if (result?.error) {
			setError('Invalid email or password')
			return
		}
		// Redirect based on business type
		const session = await getSession()
		const bType = (session?.user as any)?.businessType ?? 'general'
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
						<span>Signing in...</span>
					</>
				) : (
					<span>Sign in</span>
				)}
			</button>
		</form>
	)
}

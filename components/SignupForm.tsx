"use client"

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ArrowRight, Briefcase, CheckCheck, Copy, Eye, EyeOff, Key, Loader2, Lock, Mail, ReceiptText, UtensilsCrossed } from 'lucide-react'

export default function SignupForm() {
	const router = useRouter()
	const [step, setStep] = useState<1 | 2>(1)
	const [onboardingStep, setOnboardingStep] = useState<1 | 2>(1)
	const [name, setName] = useState('')
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [confirmPassword, setConfirmPassword] = useState('')
	const [trackingMode, setTrackingMode] = useState<'simple' | 'dish_tracking'>('simple')
	const [qrOrderingMode, setQrOrderingMode] = useState<'order' | 'view_only' | 'disabled'>('disabled')
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [showPassword, setShowPassword] = useState(false)
	const [showConfirmPassword, setShowConfirmPassword] = useState(false)
	const [recoveryKey, setRecoveryKey] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)

	function goToStep2(e: React.FormEvent) {
		e.preventDefault()
		setError(null)
		if (password !== confirmPassword) { setError('Passwords do not match'); return }
		if (password.length < 8) { setError('Password must be at least 8 characters long'); return }
		setStep(2)
		setOnboardingStep(1)
	}

	async function submitSignup() {
		setLoading(true)
		setError(null)
		try {
			const response = await fetch('/api/auth/signup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name,
					email,
					password,
					businessType: 'restaurant',
					trackingMode,
					qrOrderingMode,
				})
			})
			const data = await response.json()
			if (!response.ok) throw new Error(data.error || 'Something went wrong')
			setRecoveryKey(data.recoveryKey)
		} catch (err: any) {
			setError(err.message || 'Failed to create account')
			setStep(1)
		} finally {
			setLoading(false)
		}
	}

	async function copyKey() {
		if (!recoveryKey) return
		await navigator.clipboard.writeText(recoveryKey)
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}

	return (
		<>
			{recoveryKey && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
					<div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8 space-y-5">
						<div className="flex items-center gap-3">
							<div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
								<Key className="h-6 w-6 text-amber-600" />
							</div>
							<div>
								<h2 className="text-xl font-bold text-gray-900">Save Your Recovery Key</h2>
								<p className="text-sm text-gray-500">You will only see this once</p>
							</div>
						</div>
						<div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4 space-y-3">
							<p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Your Recovery Key</p>
							<div className="flex items-center gap-3">
								<span className="flex-1 font-mono text-xl font-bold tracking-widest text-gray-900 select-all">{recoveryKey}</span>
								<button
									type="button"
									onClick={copyKey}
									className="flex items-center gap-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium px-3 py-2 transition-colors"
								>
									{copied ? <CheckCheck className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
									{copied ? 'Copied!' : 'Copy'}
								</button>
							</div>
						</div>
						<div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700 space-y-1">
							<p className="font-semibold">Important: store this somewhere safe.</p>
							<ul className="list-disc list-inside space-y-0.5 text-red-600">
								<li>Write it down or save it in a password manager</li>
								<li>It cannot be recovered if lost</li>
								<li>You will need it to reset your password if forgotten</li>
							</ul>
						</div>
						<button
							type="button"
							onClick={() => router.push('/pricing')}
							className="w-full rounded-xl bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700 text-white py-3.5 text-sm font-semibold shadow-lg shadow-orange-500/40 transition-all duration-200"
						>
							I Saved My Key - View Pricing &amp; Activate
						</button>
					</div>
				</div>
			)}

			{step === 1 && (
				<form onSubmit={goToStep2} className="space-y-3">
				<div className="grid grid-cols-2 gap-3">
					<div className="space-y-1">
						<label htmlFor="name" className="block text-xs font-semibold text-gray-700">Company Name</label>
						<div className="relative">
							<Briefcase className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
							<input id="name" type="text" required autoComplete="organization" placeholder="Acme Ltd."
								className="h-10 w-full border border-gray-300 rounded-lg pl-9 pr-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all placeholder:text-gray-400"
								value={name} onChange={(e) => setName(e.target.value)} />
						</div>
					</div>
					<div className="space-y-1">
						<label htmlFor="email" className="block text-xs font-semibold text-gray-700">Email</label>
						<div className="relative">
							<Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
							<input id="email" type="email" required autoComplete="email" placeholder="you@example.com"
								className="h-10 w-full border border-gray-300 rounded-lg pl-9 pr-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all placeholder:text-gray-400"
								value={email} onChange={(e) => setEmail(e.target.value)} />
						</div>
					</div>
				</div>
				<div className="grid grid-cols-2 gap-3">
					<div className="space-y-1">
						<label htmlFor="password" className="block text-xs font-semibold text-gray-700">Password</label>
						<div className="relative">
							<Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
							<input id="password" required minLength={8} autoComplete="new-password" placeholder="Min 8 chars"
								type={showPassword ? 'text' : 'password'}
								className="h-10 w-full border border-gray-300 rounded-lg pl-9 pr-9 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all placeholder:text-gray-400"
								value={password} onChange={(e) => setPassword(e.target.value)} />
							<button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
								{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
							</button>
						</div>
					</div>
					<div className="space-y-1">
						<label htmlFor="confirmPassword" className="block text-xs font-semibold text-gray-700">Confirm Password</label>
						<div className="relative">
							<Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
							<input id="confirmPassword" required minLength={8} autoComplete="new-password" placeholder="Repeat"
								type={showConfirmPassword ? 'text' : 'password'}
								className="h-10 w-full border border-gray-300 rounded-lg pl-9 pr-9 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all placeholder:text-gray-400"
								value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
							<button type="button" onClick={() => setShowConfirmPassword(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
								{showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
							</button>
						</div>
					</div>
				</div>
				{error && (
					<div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
						<svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" /></svg>
						<span className="font-medium">{error}</span>
					</div>
				)}
				<button type="submit"
					className="w-full rounded-xl bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700 active:scale-[0.98] text-white py-2.5 text-sm font-semibold shadow-lg shadow-orange-500/40 transition-all duration-200 inline-flex items-center justify-center gap-2">
					<span>Continue</span>
					<ArrowRight className="h-4 w-4" />
				</button>
			</form>
		)}

		{step === 2 && (
			<div className="space-y-4">
				<div>
					<button type="button" onClick={() => setStep(1)} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800 mb-3 transition-colors">
						<ArrowLeft className="h-3.5 w-3.5" /> Back
					</button>
					<p className="text-sm font-semibold text-gray-800">A few setup choices before your first login</p>
					<p className="text-xs text-gray-500 mt-0.5">These can all be changed later in Settings.</p>
				</div>

				{onboardingStep === 1 ? (
					<div className="space-y-3">
						<div className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800">
							<div className="flex items-center gap-2 font-semibold"><UtensilsCrossed className="h-4 w-4" /> Guest Menu Access</div>
							<p className="mt-1 text-xs leading-relaxed text-orange-700">Choose whether guests can place orders themselves, only browse the menu, or whether your restaurant does not use table QR access at all.</p>
						</div>
						<button type="button" onClick={() => setQrOrderingMode('disabled')}
							className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
								qrOrderingMode === 'disabled'
									? 'border-orange-500 bg-orange-50'
									: 'border-gray-200 bg-white hover:border-gray-300'
							}`}>
							<div className="flex items-start gap-3">
								<div className={`p-2 rounded-lg flex-shrink-0 ${qrOrderingMode === 'disabled' ? 'bg-orange-100' : 'bg-gray-100'}`}>
									<Briefcase className={`h-5 w-5 ${qrOrderingMode === 'disabled' ? 'text-orange-600' : 'text-gray-500'}`} />
								</div>
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2">
										<p className={`text-sm font-bold ${qrOrderingMode === 'disabled' ? 'text-orange-700' : 'text-gray-800'}`}>We do not use QR code</p>
										{qrOrderingMode === 'disabled' && <span className="text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full">Selected</span>}
									</div>
									<p className="text-xs text-gray-500 mt-1 leading-relaxed">Best for restaurants that do not want guests using table QR pages. Staff handle everything directly.</p>
								</div>
							</div>
						</button>
						<button type="button" onClick={() => setQrOrderingMode('order')}
							className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
								qrOrderingMode === 'order'
									? 'border-orange-500 bg-orange-50'
									: 'border-gray-200 bg-white hover:border-gray-300'
							}`}>
							<div className="flex items-start gap-3">
								<div className={`p-2 rounded-lg flex-shrink-0 ${qrOrderingMode === 'order' ? 'bg-orange-100' : 'bg-gray-100'}`}>
									<UtensilsCrossed className={`h-5 w-5 ${qrOrderingMode === 'order' ? 'text-orange-600' : 'text-gray-500'}`} />
								</div>
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2">
										<p className={`text-sm font-bold ${qrOrderingMode === 'order' ? 'text-orange-700' : 'text-gray-800'}`}>Guests can view menu and order</p>
										{qrOrderingMode === 'order' && <span className="text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full">Selected</span>}
									</div>
									<p className="text-xs text-gray-500 mt-1 leading-relaxed">Best for table ordering. Guests can send orders straight into the restaurant order queue and kitchen flow.</p>
								</div>
							</div>
						</button>

						<button type="button" onClick={() => setQrOrderingMode('view_only')}
							className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
								qrOrderingMode === 'view_only'
									? 'border-orange-500 bg-orange-50'
									: 'border-gray-200 bg-white hover:border-gray-300'
							}`}>
							<div className="flex items-start gap-3">
								<div className={`p-2 rounded-lg flex-shrink-0 ${qrOrderingMode === 'view_only' ? 'bg-orange-100' : 'bg-gray-100'}`}>
									<ReceiptText className={`h-5 w-5 ${qrOrderingMode === 'view_only' ? 'text-orange-600' : 'text-gray-500'}`} />
								</div>
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2">
										<p className={`text-sm font-bold ${qrOrderingMode === 'view_only' ? 'text-orange-700' : 'text-gray-800'}`}>Guests can only view the menu</p>
										{qrOrderingMode === 'view_only' && <span className="text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full">Selected</span>}
									</div>
									<p className="text-xs text-gray-500 mt-1 leading-relaxed">Best if waiters always take orders. Guests can still see the full menu and pricing.</p>
								</div>
							</div>
						</button>

						<button type="button" onClick={() => setOnboardingStep(2)} className="w-full rounded-xl bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700 text-white py-2.5 text-sm font-semibold shadow-lg shadow-orange-500/40 transition-all duration-200 inline-flex items-center justify-center gap-2">
							<span>Next Question</span>
							<ArrowRight className="h-4 w-4" />
						</button>
					</div>
				) : (
					<div className="space-y-3">
						<div className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800">
							<div className="flex items-center gap-2 font-semibold"><UtensilsCrossed className="h-4 w-4" /> Profit Tracking Question</div>
							<p className="mt-1 text-xs leading-relaxed text-orange-700">Choose whether you want simple financial tracking only, or full dish and ingredient tracking with food cost, waste, tables, and kitchen workflow.</p>
						</div>
						<button type="button" onClick={() => setTrackingMode('simple')}
						className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
							trackingMode === 'simple'
								? 'border-orange-500 bg-orange-50'
								: 'border-gray-200 bg-white hover:border-gray-300'
						}`}>
						<div className="flex items-start gap-3">
							<div className={`p-2 rounded-lg flex-shrink-0 ${trackingMode === 'simple' ? 'bg-orange-100' : 'bg-gray-100'}`}>
								<ReceiptText className={`h-5 w-5 ${trackingMode === 'simple' ? 'text-orange-600' : 'text-gray-500'}`} />
							</div>
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2">
									<p className={`text-sm font-bold ${trackingMode === 'simple' ? 'text-orange-700' : 'text-gray-800'}`}>
									Simple — Financial Records Only
									</p>
									{trackingMode === 'simple' && (
										<span className="text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full">Selected</span>
									)}
								</div>
								<p className="text-xs text-gray-500 mt-1 leading-relaxed">
								AI reads receipts &amp; images → records straight into transactions and financial reports. No dish setup or ingredient lists needed. Best for managers who want clean financial records without complex configuration.
								</p>
								<div className="flex flex-wrap gap-1.5 mt-2">
								{['✅ Transactions', '✅ Income & Expenses', '✅ AI receipt scanning', '✅ Financial reports', '❌ Dish menu', '❌ Ingredient tracking'].map(tag => (
										<span key={tag} className="text-[10px] bg-white border border-gray-200 rounded-full px-2 py-0.5 text-gray-600">{tag}</span>
									))}
								</div>
							</div>
						</div>
					</button>

						<button type="button" onClick={() => setTrackingMode('dish_tracking')}
						className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
							trackingMode === 'dish_tracking'
								? 'border-orange-500 bg-orange-50'
								: 'border-gray-200 bg-white hover:border-gray-300'
						}`}>
						<div className="flex items-start gap-3">
							<div className={`p-2 rounded-lg flex-shrink-0 ${trackingMode === 'dish_tracking' ? 'bg-orange-100' : 'bg-gray-100'}`}>
								<UtensilsCrossed className={`h-5 w-5 ${trackingMode === 'dish_tracking' ? 'text-orange-600' : 'text-gray-500'}`} />
							</div>
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2">
									<p className={`text-sm font-bold ${trackingMode === 'dish_tracking' ? 'text-orange-700' : 'text-gray-800'}`}>
									Dish Tracking — Full Kitchen Control
									</p>
									{trackingMode === 'dish_tracking' && (
										<span className="text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full">Selected</span>
									)}
								</div>
								<p className="text-xs text-gray-500 mt-1 leading-relaxed">
									Build your menu with dishes and their exact ingredients. Every order automatically deducts stock from inventory. Track what's running low, monitor waste, and see real ingredient costs per dish. Requires initial setup of your menu and recipes.
								</p>
								<div className="flex flex-wrap gap-1.5 mt-2">
									{['Everything in Simple', 'Dish menu builder', 'Ingredient per dish', 'Auto stock deduction', 'Waste tracking', 'Tables & Kitchen display'].map(tag => (
										<span key={tag} className="text-[10px] bg-white border border-gray-200 rounded-full px-2 py-0.5 text-gray-600">{tag}</span>
									))}
								</div>
							</div>
						</div>
					</button>

						{error && (
							<div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
								<svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" /></svg>
								<span className="font-medium">{error}</span>
							</div>
						)}

						<div className="flex gap-2">
							<button type="button" onClick={() => setOnboardingStep(1)} className="flex-1 rounded-xl border border-gray-300 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors inline-flex items-center justify-center gap-2">
								<ArrowLeft className="h-4 w-4" />
								Back
							</button>
							<button type="button" onClick={submitSignup} disabled={loading}
								className="flex-1 rounded-xl bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700 active:scale-[0.98] text-white py-2.5 text-sm font-semibold shadow-lg shadow-orange-500/40 disabled:opacity-60 disabled:cursor-not-allowed transition-all duration-200 inline-flex items-center justify-center gap-2">
								{loading ? (
									<><Loader2 className="h-4 w-4 animate-spin" /><span>Creating account...</span></>
								) : (
									<span>Create Account</span>
								)}
							</button>
						</div>
					</div>
				)}
			</div>
		)}
		</>
	)
}

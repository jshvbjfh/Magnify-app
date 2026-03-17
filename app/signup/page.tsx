import { getServerSession } from 'next-auth/next'
import { redirect } from 'next/navigation'
import { authOptions } from '@/lib/auth'
import SignupForm from '@/components/SignupForm'
import { Sparkles, BarChart2, ShieldCheck, Zap } from 'lucide-react'
import Link from 'next/link'

export default async function SignupPage() {
	const session = await getServerSession(authOptions)
	if (session?.user) redirect('/restaurant')

	return (
		<main className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
			<div className="w-full max-w-5xl flex rounded-2xl shadow-2xl overflow-hidden animate-in fade-in duration-500" style={{ minHeight: '580px' }}>

				{/* Left Panel — Branded */}
				<div
					className="hidden md:flex md:w-5/12 flex-col justify-between p-10 relative bg-cover bg-center"
					style={{ backgroundImage: "url('/pic/pexels-tima-miroshnichenko-6694543.jpg')" }}
				>
					<div className="absolute inset-0 bg-gradient-to-br from-gray-900/90 via-gray-800/85 to-black/90" />

					{/* Logo */}
					<div className="relative z-10 flex items-center gap-3">
						<div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/20 backdrop-blur-sm">
							<Sparkles className="h-5 w-5 text-white" />
						</div>
						<span className="text-white font-bold text-lg tracking-tight">Magnify</span>
					</div>

					{/* Headline */}
					<div className="relative z-10 space-y-4">
						<h2 className="text-3xl font-bold text-white leading-snug">Smart Accounting<br />for Every Business</h2>
						<p className="text-orange-100 text-sm leading-relaxed">Manage tables, orders, staff, and get AI-powered insights — all in one place.</p>

						<div className="space-y-3 pt-2">
							{[
								{ icon: BarChart2, text: 'Real-time financial reports' },
								{ icon: Zap, text: 'AI-powered transaction analysis' },
								{ icon: ShieldCheck, text: 'Secure & offline-ready' },
							].map(({ icon: Icon, text }) => (
								<div key={text} className="flex items-center gap-3">
									<div className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/20">
										<Icon className="h-4 w-4 text-white" />
									</div>
									<span className="text-sm text-orange-100">{text}</span>
								</div>
							))}
						</div>
					</div>

					{/* Already have account */}
					<div className="relative z-10">
						<p className="text-orange-200 text-sm">Already have an account?</p>
						<Link href="/login" className="inline-block mt-2 px-5 py-2 rounded-xl border-2 border-white/50 text-white text-sm font-semibold hover:bg-white/10 transition-colors">
							Sign In
						</Link>
					</div>
				</div>

				{/* Right Panel — Form */}
				<div className="flex-1 bg-white flex flex-col justify-center px-8 py-8 overflow-y-auto">
					<div className="max-w-sm w-full mx-auto">
						{/* Mobile logo (hidden on md+) */}
						<div className="flex md:hidden items-center gap-2 mb-6">
						<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-red-600">
								<Sparkles className="h-4 w-4 text-white" />
							</div>
							<span className="font-bold text-gray-900">Magnify</span>
						</div>

						<h1 className="text-2xl font-bold text-gray-900 mb-1">Create Account</h1>
						<p className="text-sm text-gray-500 mb-6">Fill in your details to get started</p>

						<SignupForm />

						{/* Mobile sign-in link */}
						<p className="md:hidden text-center text-sm text-gray-600 mt-4">
							Already have an account?{' '}
							<Link href="/login" className="font-semibold text-orange-600 hover:text-orange-700">Sign in</Link>
						</p>
					</div>
				</div>
			</div>
		</main>
	)
}

import { getServerSession } from 'next-auth/next'
import { redirect } from 'next/navigation'
import { authOptions } from '@/lib/auth'
import LoginForm from '@/components/LoginForm'
import Link from 'next/link'
import { Sparkles } from 'lucide-react'

export default async function LoginPage({
	searchParams
}: {
	searchParams: { registered?: string }
}) {
	const session = await getServerSession(authOptions)
	if (session?.user) redirect('/restaurant')

	return (
		<main className="min-h-screen flex items-center justify-center px-4 py-12 relative">
			{/* Background Image */}
			<div 
				className="absolute inset-0 bg-cover bg-center bg-no-repeat"
				style={{ backgroundImage: "url('/pic/alexandru-bogdan-ghita-UeYkqQh4PoI-unsplash.jpg')" }}
			>
				{/* Gradient overlay for depth and readability */}
				<div className="absolute inset-0 bg-gradient-to-br from-black/50 via-black/40 to-black/50"></div>
			</div>
			
			{/* Login Card with enhanced styling */}
			<div className="w-full max-w-[440px] bg-white backdrop-blur-md border border-white/20 rounded-2xl shadow-2xl p-10 relative z-10 animate-in fade-in slide-in-from-bottom-4 duration-500">
				<div className="text-center mb-10">
					{/* Logo/Brand */}
					<div className="inline-flex items-center justify-center w-20 h-20 bg-gradient-to-br from-orange-500 to-red-600 rounded-2xl mb-5 shadow-lg shadow-orange-500/30">
						<Sparkles className="h-9 w-9 text-white" />
					</div>
					
					<h1 className="text-3xl font-bold bg-gradient-to-r from-gray-900 to-gray-700 bg-clip-text text-transparent mb-2">Magnify</h1>
					<p className="text-sm text-gray-600 font-medium">Restaurant Management System</p>
					
					<div className="mt-4 inline-flex items-center gap-2 bg-orange-50 text-orange-700 text-xs font-semibold px-4 py-2 rounded-full border border-orange-100">
						<div className="w-1.5 h-1.5 bg-orange-500 rounded-full animate-pulse"></div>
						AI Powered
					</div>
				</div>
				
				{/* Success message */}
				{searchParams?.registered === 'true' && (
					<div className="mb-6 flex items-start gap-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded-xl px-4 py-3 animate-in slide-in-from-top-1 duration-300">
						<svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
							<path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
						</svg>
						<span className="font-medium">Account created successfully! Please sign in.</span>
					</div>
				)}
				
				<LoginForm />
				
				{/* Sign Up Link */}
				<div className="mt-8 pt-6 border-t border-gray-100 text-center">
					<p className="text-sm text-gray-600">
						Don't have an account?{' '}
						<Link href="/signup" className="font-semibold text-orange-600 hover:text-orange-700 transition-colors">
							Sign up
						</Link>
					</p>
					<p className="text-xs text-gray-500 mt-3">
						Secure access to your financial insights
					</p>
				</div>
			</div>
		</main>
	)
}

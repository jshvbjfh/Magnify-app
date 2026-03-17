'use client'

import { signOut, useSession } from 'next-auth/react'
import { LogOut, Sparkles, Languages } from 'lucide-react'
import { useLanguage } from '@/contexts/LanguageContext'

export default function Navbar() {
	const { data: session } = useSession()
	const { language, setLanguage } = useLanguage()

	const toggleLanguage = () => {
		setLanguage(language === 'en' ? 'rw' : 'en')
	}

	return (
		<header className="fixed top-0 left-0 right-0 z-50 border-b bg-white shadow-sm">
			<div className="flex items-center justify-between px-6 py-4">
				<div>
					<div className="flex items-center gap-3">
						<h1 className="text-lg font-bold text-gray-900">Magnify</h1>
						<span className="flex items-center gap-2 text-xs text-gray-500 font-semibold">
							<Sparkles className="h-3.5 w-3.5 text-gray-400" />
							v3.2
						</span>
					</div>
					<p className="text-xs text-gray-500 mt-0.5">Financial Management System</p>
				</div>
			<div className="flex items-center gap-4">
				{/* Language Switcher */}
				<button
					onClick={toggleLanguage}
					className="inline-flex items-center gap-2 text-sm border-2 border-orange-500 bg-orange-50 hover:bg-orange-100 text-orange-700 rounded-lg px-3 py-1.5 transition-colors font-medium"
					title={language === 'en' ? 'Switch to Kinyarwanda' : 'Switch to English'}
				>
					<Languages className="h-4 w-4" />
					<span className="font-semibold">{language === 'en' ? 'EN' : 'RW'}</span>
				</button>

				{session?.user?.email && (
					<span className="hidden lg:block text-sm text-gray-600 font-medium max-w-[200px] truncate" title={session.user.email}>{session.user.email}</span>
				)}
				<button
					onClick={() => signOut({ callbackUrl: '/login' })}
					className="inline-flex items-center gap-2 text-sm border border-gray-300 hover:bg-gray-50 rounded-lg px-4 py-2 transition-colors"
				>
					<LogOut className="h-4 w-4" />
					Sign out
				</button>
			</div>
			</div>
		</header>
	)
}

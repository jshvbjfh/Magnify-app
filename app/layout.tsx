import './globals.css'
import AppSessionProvider from '@/components/SessionProvider'
import { LanguageProvider } from '@/contexts/LanguageContext'
import type { Viewport } from 'next'

export const viewport: Viewport = {
	width: 'device-width',
	initialScale: 1,
	maximumScale: 1,
}

export const metadata = {
	title: 'Magnify - Restaurant Management System',
	description: 'AI-powered restaurant management system',
	icons: {
		icon: '/icon.svg'
	}
}

export default function RootLayout({
	children
}: {
	children: React.ReactNode
}) {
	return (
		<html lang="en">
			<body className="min-h-screen antialiased bg-white text-gray-900">
				<AppSessionProvider>
					<LanguageProvider>
						{children}
					</LanguageProvider>
				</AppSessionProvider>
			</body>
		</html>
	)
}

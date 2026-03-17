'use client'

import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { Language, translations, TranslationKeys } from '@/lib/translations'

type LanguageContextType = {
	language: Language
	setLanguage: (lang: Language) => void
	t: TranslationKeys
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

export function LanguageProvider({ children }: { children: ReactNode }) {
	const [language, setLanguageState] = useState<Language>('en')

	// Load language from localStorage on mount
	useEffect(() => {
		const saved = localStorage.getItem('appLanguage') as Language
		if (saved && (saved === 'en' || saved === 'rw')) {
			setLanguageState(saved)
		}
	}, [])

	// Save language to localStorage when it changes
	const setLanguage = (lang: Language) => {
		setLanguageState(lang)
		localStorage.setItem('appLanguage', lang)
	}

	const value = {
		language,
		setLanguage,
		t: translations[language]
	}

	return (
		<LanguageContext.Provider value={value}>
			{children}
		</LanguageContext.Provider>
	)
}

export function useLanguage() {
	const context = useContext(LanguageContext)
	if (context === undefined) {
		throw new Error('useLanguage must be used within a LanguageProvider')
	}
	return context
}

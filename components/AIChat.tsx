'use client'

import React, { useState, useEffect, useRef } from 'react'
import {
	MessageCircle, Send, User, Calendar, Image as ImageIcon, X, Sparkles,
	TrendingUp, TrendingDown, CheckCircle, XCircle, AlertTriangle,
	Lightbulb, Target, Flame, Zap, Users, Clock, Banknote, Star,
	ArrowRight, ChefHat, Award, BarChart2, Sheet
} from 'lucide-react'
import * as XLSX from 'xlsx'
import { useLanguage } from '@/contexts/LanguageContext'

// Detect restaurant data questions that Jesse answers directly from the DB
// (no Gemini API key needed — instant, offline-capable)
const TIME_WORD   = /\b(today|yesterday|this\s*week|last\s*week|current\s*week|this\s*month|last\s*month|current\s*month|this\s*year|past\s+\d+\s*days?)\b/i
const METRIC_WORD = /\b(revenue|sales|income|profit|loss|orders?|expenses?|waste|food\s*cost|cogs|earned|we\s+made|how much)\b/i
const PAYMENT_W   = /\b(momo|mobile\s*money|cash\s+sales|bank\s+revenue|cheque\s+revenue|revenue\s+by|payment\s*(method|breakdown)|paid\s+by)\b/i
const SOLO_RESTAURANT = /\b(low\s*stock|running\s*out|reorder|top\s*dish(es)?|best.?sell|most\s*ordered|popular\s*dish|best\s*drink|our\s+best|pending\s+orders?|open\s+orders?|outstanding\s+orders?|which\s+branch|revenue\s+by\s+branch|top\s+branch|average\s+order|avg\s+order|branch\s+by\s+branch|by\s+branch|expenses\s+by\s+branch|profit\s+by\s+branch)\b|\b(what|how)\s+about\s+(yesterday|today|this\s+week|last\s+week|this\s+month|last\s+month|this\s+year|past\s+\d+\s+days?)\b|\band\s+(yesterday|last\s+week|last\s+month|this\s+week|this\s+month)\b|\b(what\s+happened|why\s+(did|was|is|are)|what\s+does\s+that\s+mean|tell\s+me\s+more|explain\s+that|what\s+went\s+wrong|why\s+zero|why\s+0)\b/i
const STOCK_LEVEL_W   = /\b(in\s+stock|stock\s+level|do\s+we\s+have|how\s+much\s+\w|how\s+many\s+\w+\s+of|quantity\s+of|stock\s+of)\b/i
const DISH_QUERY_W    = /\b(revenue|sales|made|earned)\s+(from|of)\s+[a-z]|how\s+many\s+[a-z][\w\s]+\s+(did\s+we\s+sell|sold)|how\s+much\s+(did\s+we\s+make\s+from|from)\s+[a-z]/i
const GREETING_W      = /^(hi+|hello+|hey+|good\s*(morning|afternoon|evening|day|night)|howdy|greetings|morning|evening|afternoon|how\s+are\s+you|how'?s\s+it|what'?s\s+up|sup|yo|salut|bonjour|hola|jambo|muraho|niaje|habari|mwaramutse|amakuru)\b/i
const RECORD_TX_W     = new RegExp([
  // Clear recording commands
  '\\b(record\\s+this|log\\s+this|save\\s+this\\s+(transaction|expense|payment)|add\\s+this\\s+entry|create\\s+(an?\\s+)?entry|book\\s+this|register\\s+this\\s+payment|enter\\s+this\\s+expense|post\\s+this\\s+entry|journalize|add\\s+to\\s+(ledger|books)|process\\s+payroll|close\\s+the\\s+books|reconcile\\s+account|bank\\s+reconciliation|accrue\\s+this|defer\\s+this|capitalize\\s+this|amortize\\s+this|write\\s+off\\s+the|reverse\\s+accrual|note\\s+this\\s+transaction|track\\s+this\\s+(purchase|payment|expense)|capture\\s+this\\s+expense|post\\s+to\\s+ledger)\\b',
  // Explicit record triggers
  '\\b(record|log|add|post|enter)\\s+(?:a\\s+)?(?:transaction|entry|expense|income|payment|sale|purchase|journal|payroll|salary|refund|invoice|deposit|loan|asset|depreciation)\\b',
  // Income sentence phrases
  '\\b(received\\s+payment|got\\s+paid|client\\s+(paid|cleared|settled)|customer\\s+(paid|settled|cleared)|invoice\\s+was\\s+paid|received\\s+money|money\\s+came\\s+in|received\\s+deposit|got\\s+revenue|earned\\s+income|collected\\s+cash|payment\\s+received|booked\\s+revenue|sales\\s+came\\s+in|cash\\s+received\\s+today|money\\s+received\\s+today|client\\s+finally\\s+paid|customer\\s+cleared|supplier\\s+refunded\\s+us|refund\\s+received|settlement\\s+received|financing\\s+received|funding\\s+secured|investment\\s+received|dividend\\s+received|remittance\\s+received|claim\\s+received|insurance\\s+payout|we\\s+received\\s+cash)\\b',
  // Expense sentence phrases
  '\\b(settled\\s+the\\s+bill|cleared\\s+the\\s+invoice|paid\\s+(supplier|vendor|employees|staff|salary|wages|rent|invoice|contractor|freelancer|tax|vat|insurance|bill|interest|loan|penalty|fee)|paid\\s+via\\s+(mtn|airtel|momo|bank|card)|processed\\s+payroll|salary\\s+paid|wages\\s+paid|payroll\\s+processed|commission\\s+paid|bonus\\s+paid|reimbursed\\s+employee|made\\s+(a\\s+)?payment|sent\\s+payment|transferred\\s+funds|moved\\s+money|bank\\s+charged\\s+fee|bank\\s+deducted|withdrew\\s+cash|deposited\\s+cash|momo\\s+payment|mobile\\s+money\\s+payment|card\\s+was\\s+charged|supplier\\s+has\\s+been\\s+paid|employee\\s+salaries\\s+went\\s+out|we\\s+paid\\s+for|we\\s+(spent|bought|purchased)|subscription\\s+renewed|insurance\\s+premium\\s+paid|maintenance\\s+contract\\s+renewed|advance\\s+payment\\s+made|prepayment\\s+made|security\\s+deposit\\s+paid|converted\\s+currency|forex\\s+(gain|loss)|owner\\s+(invested|withdrew)|capital\\s+injected|dividend\\s+paid|drawings\\s+recorded|customer\\s+refunded|refund\\s+issued|credit\\s+note\\s+issued|discount\\s+(applied|given)|purchase\\s+returned|damaged\\s+goods)\\b',
  // With amounts: action words + number
  '\\b(paid|spent|bought|purchased|received|earned|sold|withdrew|deposited)\\s+[\\d,]+',
  '\\b[\\d,]+\\s*(k\\b)?\\s+(for|on)\\s+\\w',
  '\\b(fuel|diesel|rent|salary|wages|payroll|electricity|water\\s+bill|airtime|internet\\s+bill|phone\\s+bill|data\\s+bundle|repair|maintenance|supplies|insurance|vat|paye|bonus|overtime|cleaning|transport|delivery|capex|depreciation|loan\\s+repayment|installment|mortgage|dividend|drawings|petty\\s+cash|shipping|freight|customs|logistics|marketing|advertising|legal\\s+fee|audit\\s+fee|consultancy|training|workshop|seminar|school\\s+fees|membership|donation|interest\\s+expense|bank\\s+fee|hosting|saas|cloud|hardware|telecom|procurement|packaging|warehousing|sponsorship|permit\\s+fee|government\\s+fee|oil\\s+change|advance\\s+payment|prepayment|reimbursement|settlement)\\s+[\\d,]+',
  '\\b(expense|payment|bill|invoice|fee|charge|cost)\\s+of\\s+[\\d,]+',
  // Accounting terms (always record intent)
  '\\b(journal\\s+entry|ledger\\s+entry|bookkeeping|accrual|adjustment\\s+entry|reversal\\s+entry|adjusting\\s+entry|journalize|create\\s+adjusting\\s+entry|close\\s+(revenue|expense)\\s+account|record\\s+retained\\s+earnings)\\b',
  // Natural conversational
  '\\b(please\\s+save\\s+this\\s+expense|add\\s+this\\s+to\\s+(accounting|books)|I\\s+need\\s+this\\s+recorded|log\\s+the\\s+(utility|fuel|salary|rent|payroll|water|electricity|internet)\\s+payment|record\\s+today.?s\\s+sales|register\\s+the\\s+incoming\\s+transfer|the\\s+bank\\s+deducted)\\b',
].join('|'), 'i')

function isRestaurantDataQuery(q: string) {
  const isQuery = /\b(how much|how many|what did|what are|how little|which|show me|list|total|summary|report)\b/i.test(q)
  const isRecordIntent = !isQuery && RECORD_TX_W.test(q)
  return GREETING_W.test(q.trim()) || isRecordIntent || SOLO_RESTAURANT.test(q) || PAYMENT_W.test(q) || STOCK_LEVEL_W.test(q) || DISH_QUERY_W.test(q) || (TIME_WORD.test(q) && METRIC_WORD.test(q))
}

type Message = {
	id: string
	role: 'user' | 'assistant'
	content: string
	images?: string[] // Image URLs/paths
	timestamp: Date
}

// ─── Icon-aware message renderer ───────────────────────────────────────────
const ICON_MAP: Record<string, React.ReactNode> = {
	TrendingUp:    <TrendingUp    className="inline h-3.5 w-3.5 text-green-500 mx-0.5 align-middle" />,
	TrendingDown:  <TrendingDown  className="inline h-3.5 w-3.5 text-red-500 mx-0.5 align-middle" />,
	CheckCircle:   <CheckCircle   className="inline h-3.5 w-3.5 text-green-500 mx-0.5 align-middle" />,
	XCircle:       <XCircle       className="inline h-3.5 w-3.5 text-red-500 mx-0.5 align-middle" />,
	AlertTriangle: <AlertTriangle className="inline h-3.5 w-3.5 text-amber-500 mx-0.5 align-middle" />,
	Lightbulb:     <Lightbulb     className="inline h-3.5 w-3.5 text-yellow-500 mx-0.5 align-middle" />,
	Target:        <Target        className="inline h-3.5 w-3.5 text-blue-500 mx-0.5 align-middle" />,
	Flame:         <Flame         className="inline h-3.5 w-3.5 text-orange-500 mx-0.5 align-middle" />,
	Zap:           <Zap           className="inline h-3.5 w-3.5 text-yellow-400 mx-0.5 align-middle" />,
	Users:         <Users         className="inline h-3.5 w-3.5 text-blue-400 mx-0.5 align-middle" />,
	Clock:         <Clock         className="inline h-3.5 w-3.5 text-gray-500 mx-0.5 align-middle" />,
	Banknote:      <Banknote      className="inline h-3.5 w-3.5 text-green-600 mx-0.5 align-middle" />,
	Star:          <Star          className="inline h-3.5 w-3.5 text-yellow-500 mx-0.5 align-middle" />,
	ArrowRight:    <ArrowRight    className="inline h-3.5 w-3.5 mx-0.5 align-middle" />,
	ChefHat:       <ChefHat       className="inline h-3.5 w-3.5 mx-0.5 align-middle" />,
	Award:         <Award         className="inline h-3.5 w-3.5 text-orange-500 mx-0.5 align-middle" />,
	BarChart2:     <BarChart2     className="inline h-3.5 w-3.5 mx-0.5 align-middle" />,
}

function parseInline(text: string, lineKey: string): React.ReactNode[] {
	const INLINE = /::([\w]+)::|\*\*((?:[^*]|\*(?!\*))+)\*\*/g
	const parts: React.ReactNode[] = []
	let lastIdx = 0
	let partIdx = 0
	let m: RegExpExecArray | null
	while ((m = INLINE.exec(text)) !== null) {
		if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index))
		if (m[1]) {
			parts.push(
				<span key={`${lineKey}-i${partIdx++}`} className="inline-flex items-center">
					{ICON_MAP[m[1]] ?? <span className="text-xs bg-gray-200 rounded px-0.5">{m[1]}</span>}
				</span>
			)
		} else if (m[2]) {
			parts.push(<strong key={`${lineKey}-b${partIdx++}`}>{m[2]}</strong>)
		}
		lastIdx = m.index + m[0].length
	}
	if (lastIdx < text.length) parts.push(text.slice(lastIdx))
	return parts
}

function renderMessageContent(content: string) {
	const lines = content.split('\n')
	return (
		<div className="text-sm font-medium leading-relaxed">
			{lines.map((line, i) => {
				if (line.trim() === '') return <div key={i} className="h-1.5" />
				return (
					<div key={i} className="leading-relaxed">
						{parseInline(line, `l${i}`)}
					</div>
				)
			})}
		</div>
	)
}

type PendingFinancialRecord = {
	items: Array<{ name: string; unitPrice: number; quantity: number; unit?: string }>
	totalAmount: number
}

function isSharedQuotaMessage(content: string) {
	const normalized = content.toLowerCase()
	return normalized.includes('shared gemini quota')
		|| normalized.includes('all configured ai keys are currently unavailable')
		|| normalized.includes('jesse ai is temporarily unavailable')
		|| normalized.includes('shared jesse ai service')
}

function createWelcomeMessage(): Message[] {
	return [{
		id: 'welcome-message',
		role: 'assistant',
		content: "Hi, how can I help you today?",
		timestamp: new Date()
	}]
}

export default function AIChat() {
	const { t } = useLanguage()
	const [messages, setMessages] = useState<Message[]>([])
	const [allMessages, setAllMessages] = useState<Message[]>([])
	const [input, setInput] = useState('')
	const [selectedImages, setSelectedImages] = useState<File[]>([])
	const [loading, setLoading] = useState(false)
	const [loadingPhase, setLoadingPhase] = useState<string>('')
	const [loadingHistory, setLoadingHistory] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [typingMessageId, setTypingMessageId] = useState<string | null>(null)
	const [typingText, setTypingText] = useState<string>('')
	const typingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
	const [selectedDate, setSelectedDate] = useState<string>('all')
	const [conversationMode, setConversationMode] = useState<'history' | 'new'>('history')
	const [showDatePicker, setShowDatePicker] = useState(false)
	const [pendingFinancialRecord, setPendingFinancialRecord] = useState<PendingFinancialRecord | null>(null)
	const messagesEndRef = useRef<HTMLDivElement>(null)
	const fileInputRef = useRef<HTMLInputElement>(null)
	const excelInputRef = useRef<HTMLInputElement>(null)
	const conversationModeRef = useRef<'history' | 'new'>('history')

	useEffect(() => {
		conversationModeRef.current = conversationMode
	}, [conversationMode])

	// Listen for analytics context from the Analytics page
	useEffect(() => {
		const handleAnalyticsContext = (e: Event) => {
			const { prompt } = (e as CustomEvent).detail || {}
			if (prompt) setInput(prompt)
		}
		window.addEventListener('openJesseWithContext', handleAnalyticsContext)
		return () => window.removeEventListener('openJesseWithContext', handleAnalyticsContext)
	}, [])

	// Load draft message from localStorage on mount
	useEffect(() => {
		const savedDraft = localStorage.getItem('aiChatDraft')
		if (savedDraft) {
			setInput(savedDraft)
		}
	}, [])

	// Save draft message to localStorage whenever it changes
	useEffect(() => {
		if (input) {
			localStorage.setItem('aiChatDraft', input)
		} else {
			localStorage.removeItem('aiChatDraft')
		}
	}, [input])

	// Auto-scroll to bottom when messages change
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
	}, [messages, loading])

	// Cleanup typing animation on unmount
	useEffect(() => {
		return () => { if (typingTimerRef.current) clearInterval(typingTimerRef.current) }
	}, [])

	// Scroll as typing text grows
	useEffect(() => {
		if (typingMessageId) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
	}, [typingText, typingMessageId])

	function startTypingAnimation(messageId: string, fullText: string) {
		if (typingTimerRef.current) clearInterval(typingTimerRef.current)
		setTypingMessageId(messageId)
		setTypingText('')

		// Split into words so markdown syntax is never broken mid-token
		const words = fullText.split(/(\s+)/)  // keeps whitespace as separate tokens
		let wordIndex = 0
		// Speed: ~40ms per word feels natural; long messages get a bit faster
		const delayMs = fullText.length > 600 ? 20 : fullText.length > 200 ? 30 : 40

		typingTimerRef.current = setInterval(() => {
			wordIndex++
			if (wordIndex >= words.length) {
				setTypingText(fullText)
				setTypingMessageId(null)
				if (typingTimerRef.current) clearInterval(typingTimerRef.current)
				typingTimerRef.current = null
			} else {
				setTypingText(words.slice(0, wordIndex).join(''))
			}
		}, delayMs)
	}

	// Load chat history from database on mount
	useEffect(() => {
		loadChatHistory()
	}, [])

	// Listen for transactionsUpdated events from AIQuestions (auto-reprocess after dictionary word definition)
	useEffect(() => {
		const handleTransactionsUpdated = (e: Event) => {
			const customEvent = e as CustomEvent
			const { count, source } = customEvent.detail || {}
			console.log(`[AIChat] Transactions updated: ${count} transactions from ${source}`)
			
			// Reload chat history to show new transactions
			loadChatHistory()
			
			// Dispatch event to other components (like DashboardShell) to refresh their views
			window.dispatchEvent(new CustomEvent('refreshTransactions', { 
				detail: { count, source: source || 'ai_chat' } 
			}))
		}

		window.addEventListener('transactionsUpdated', handleTransactionsUpdated)
		
		return () => {
			window.removeEventListener('transactionsUpdated', handleTransactionsUpdated)
		}
	}, [])

	// Filter messages by selected date
	useEffect(() => {
		if (conversationMode === 'new') {
			setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
			return
		}
		if (selectedDate === 'all') {
			setMessages(allMessages)
		} else {
			const filtered = allMessages.filter(msg => {
				const msgDate = new Date(msg.timestamp).toISOString().split('T')[0]
				return msgDate === selectedDate
			})
			setMessages(filtered)
		}
		// Auto-scroll after filtering
		setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
	}, [selectedDate, allMessages, conversationMode])

	async function loadChatHistory() {
		setLoadingHistory(true)
		try {
			const res = await fetch('/api/ai/messages?limit=10000', {
				credentials: 'include'
			})
			
			if (res.ok) {
				const data = await res.json()
				console.log('Loaded chat history:', data) // Debug log
				if (data.messages && data.messages.length > 0) {
					const loadedMessages = data.messages.map((msg: any) => ({
						...msg,
						timestamp: new Date(msg.timestamp)
					}))
					console.log('Setting messages:', loadedMessages) // Debug log
					setAllMessages(loadedMessages)
					if (conversationModeRef.current === 'history') {
						setMessages(loadedMessages)
					}
				} else {
					const welcomeMsg = createWelcomeMessage()
					setAllMessages(welcomeMsg)
					if (conversationModeRef.current === 'history') {
						setMessages(welcomeMsg)
					}
				}
			} else {
				console.error('Failed to load chat history:', await res.text())
			}
		} catch (e: any) {
			console.error('Failed to load chat history:', e)
		} finally {
			setLoadingHistory(false)
		}
	}

	async function saveMessage(role: 'user' | 'assistant', content: string, images?: string[]): Promise<string> {
		try {
			const res = await fetch('/api/ai/messages', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ role, content, images })
			})

			if (res.ok) {
				const data = await res.json()
				return data.message.id
			}
		} catch (e) {
			console.error('Failed to save message:', e)
		}
		return Date.now().toString()
	}

	// FUNCTION DISABLED - Chat history deletion is permanently disabled
	// All conversations are saved for complete audit trail and record-keeping
	// async function clearHistory() {
	// 	// Chat deletion is disabled - chats are permanently saved
	// }

	function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
		const files = Array.from(e.target.files || [])
		if (files.length > 0) {
			// Limit to 5 images
			const newImages = files.slice(0, 5 - selectedImages.length)
			setSelectedImages(prev => [...prev, ...newImages])
		}
		// Reset input so same file can be selected again
		if (e.target) e.target.value = ''
	}

	function removeImage(index: number) {
		setSelectedImages(prev => prev.filter((_, i) => i !== index))
	}

	async function handleExcelUpload(e: React.ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0]
		if (!file) return
		if (e.target) e.target.value = ''

		const userContent = `Importing Excel file: ${file.name}`
		const uId = await saveMessage('user', userContent)
		const uMsg: Message = { id: uId, role: 'user', content: userContent, timestamp: new Date() }
		setAllMessages(prev => [...prev, uMsg])
		setMessages(prev => [...prev, uMsg])
		setLoading(true)
		setLoadingPhase('reading...')

		let phaseTimer1: ReturnType<typeof setTimeout> | null = null
		let phaseTimer2: ReturnType<typeof setTimeout> | null = null
		let phaseTimer3: ReturnType<typeof setTimeout> | null = null

		try {
			const buffer = await file.arrayBuffer()
			const wb = XLSX.read(buffer)
			const ws = wb.Sheets[wb.SheetNames[0]]
			const rows = XLSX.utils.sheet_to_json(ws, { defval: '' }) as Record<string, unknown>[]

			if (rows.length === 0) {
				const msg = 'The Excel file appears to be empty or has no data rows.'
				const id = await saveMessage('assistant', msg)
				const m: Message = { id, role: 'assistant', content: msg, timestamp: new Date() }
				setAllMessages(prev => [...prev, m])
				setMessages(prev => [...prev, m])
				return
			}

			setLoadingPhase('thinking...')
			phaseTimer1 = setTimeout(() => setLoadingPhase('untangling the spaghetti....'), 2500)
			phaseTimer2 = setTimeout(() => setLoadingPhase('recording...'), 5500)
			phaseTimer3 = setTimeout(() => setLoadingPhase('magnifying....'), 10000)

			const res = await fetch('/api/restaurant/ask-jesse', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ importRows: rows, fileName: file.name }),
			})
			const data = await res.json().catch(() => ({}))
			const content = data.answer ?? "Sorry, couldn't process the file."
			const aId = await saveMessage('assistant', content)
			const aMsg: Message = { id: aId, role: 'assistant', content, timestamp: new Date() }
			setAllMessages(prev => [...prev, aMsg])
			setMessages(prev => [...prev, aMsg])
			startTypingAnimation(aId, content)
		} catch {
			const msg = `Failed to read "${file.name}". Make sure it's a valid .xlsx or .csv file.`
			const id = await saveMessage('assistant', msg)
			const m: Message = { id, role: 'assistant', content: msg, timestamp: new Date() }
			setAllMessages(prev => [...prev, m])
			setMessages(prev => [...prev, m])
		} finally {
			if (phaseTimer1) clearTimeout(phaseTimer1)
			if (phaseTimer2) clearTimeout(phaseTimer2)
			if (phaseTimer3) clearTimeout(phaseTimer3)
			setLoadingPhase('')
			setLoading(false)
		}
	}

	async function uploadImages(files: File[]): Promise<string[]> {
		const uploadedPaths: string[] = []
		
		for (const file of files) {
			const formData = new FormData()
			formData.append('file', file)
			formData.append('type', 'chat')
			
			try {
				const res = await fetch('/api/ai/upload-image', {
					method: 'POST',
					body: formData
				})
				
				if (res.ok) {
					const data = await res.json()
					uploadedPaths.push(data.path)
				}
			} catch (e) {
				console.error('Failed to upload image:', e)
			}
		}
		
		return uploadedPaths
	}

	async function sendMessage(overrideMessage?: string) {
		const userContent = (overrideMessage ?? input).trim()
		if ((!userContent && selectedImages.length === 0) || loading) return

		const imagesToUpload = [...selectedImages]
		if (!overrideMessage) setInput('')
		setSelectedImages([])
		setPendingFinancialRecord(null)
		localStorage.removeItem('aiChatDraft') // Clear draft after sending
		setLoading(true)
		setLoadingPhase('magnifying...')
		setError(null)

		// Upload images first
		const uploadedImagePaths = await uploadImages(imagesToUpload)

		// Optimistically add user message to UI
		const tempUserId = `temp-${Date.now()}`
		const userMessage: Message = {
			id: tempUserId,
			role: 'user',
			content: userContent || '📷 Sent an image',
			images: uploadedImagePaths,
			timestamp: new Date()
		}
		setAllMessages((prev) => [...prev, userMessage])
		setMessages((prev) => [...prev, userMessage])

		try {
			// Save user message to database
			const savedUserId = await saveMessage('user', userContent || '📷 Sent an image', uploadedImagePaths)
			
			// Update the temp ID with real ID
			setAllMessages(prev => prev.map(msg => 
				msg.id === tempUserId ? { ...msg, id: savedUserId } : msg
			))
			setMessages(prev => prev.map(msg => 
				msg.id === tempUserId ? { ...msg, id: savedUserId } : msg
			))

			// All text messages go to Jesse — he handles data queries, conversational
			// replies, identity questions, and everything else gracefully.
			// Only pure image-with-no-text goes to the vision API.
			if (userContent) {
				// Start advanced loading phases for heavy data queries
				const isHeavyQuery = isRestaurantDataQuery(userContent)
				let t1: ReturnType<typeof setTimeout> | null = null
				let t2: ReturnType<typeof setTimeout> | null = null
				if (isHeavyQuery) {
					t1 = setTimeout(() => setLoadingPhase('thinking...'), 1500)
					t2 = setTimeout(() => setLoadingPhase('untangling the spaghetti....'), 4000)
				}
				try {
					const rRes = await fetch('/api/restaurant/ask-jesse', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						credentials: 'include',
						body: JSON.stringify({ question: userContent }),
					})
					if (!rRes.ok) {
						const errBody = await rRes.json().catch(() => ({}))
						const errMsg = errBody?.error || ''
						if (errMsg.toLowerCase().includes('unauthorized') || rRes.status === 401) {
							throw new Error("You're not logged in. Please refresh the page and sign in again.")
						}
						if (errMsg.toLowerCase().includes('no restaurant')) {
							throw new Error("No restaurant found for your account. Make sure your setup is complete.")
						}
						throw new Error(`Something went wrong on our end (${rRes.status}). Try again in a moment.`)
					}
					const rData = await rRes.json().catch(() => ({}))
					const rContent = rData.answer ?? "I'm not sure about that one. Try asking about revenue, expenses, or inventory."
					const rId = await saveMessage('assistant', rContent)
					const rMsg: Message = { id: rId, role: 'assistant', content: rContent, timestamp: new Date() }
					setAllMessages(prev => [...prev, rMsg])
					setMessages(prev => [...prev, rMsg])
					startTypingAnimation(rId, rContent)
				} finally {
					if (t1) clearTimeout(t1)
					if (t2) clearTimeout(t2)
					setLoadingPhase('')
					setLoading(false)
				}
				return
			}

			// No text — image-only message goes to the vision API
			const res = await fetch('/api/ai/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					message: 'Please analyze this image',
					images: uploadedImagePaths,
					conversationHistory: messages.slice(-50),
				})
			})

			if (!res.ok) {
				const errBody = await res.json().catch(() => ({}))
				const errMsg = errBody?.error || errBody?.message || ''
				if (errMsg.toLowerCase().includes('gemini') || errMsg.toLowerCase().includes('api key')) {
					throw new Error('Image analysis is not configured right now. Contact your admin.')
				}
				if (res.status === 401) {
					throw new Error("You're not logged in. Please refresh and sign in again.")
				}
				throw new Error(`Image analysis failed (${res.status}). Try again in a moment.`)
			}

			const data = await res.json()
			if (data.error) {
				throw new Error("Couldn't analyse that image. Try a clearer photo or a different format.")
			}

			// Save AI response to database
			let aiContent = data.response || "I couldn't read that image. Could you try a different one?"

			// Clean up any HTML that might have slipped through
			if (aiContent.includes('<html') || aiContent.includes('<!DOCTYPE')) {
				aiContent = "That image couldn't be processed. Please try again with a different file."
			}
			
			const aiMessageId = await saveMessage('assistant', aiContent)

			const aiMessage: Message = {
				id: aiMessageId,
				role: 'assistant',
				content: aiContent,
				timestamp: new Date()
			}

			setAllMessages((prev) => [...prev, aiMessage])
			setMessages((prev) => [...prev, aiMessage])
			startTypingAnimation(aiMessageId, aiContent)
			setError(null)

			// If transactions were created, add a success message
			if (data.transactionsCreated && data.transactionsCreated.length > 0) {
				const successContent = `✅ Successfully recorded ${data.transactionsCreated.length} transaction(s):\n${data.transactionsCreated.map((t: any) => `• ${t.description}: ${t.amount.toLocaleString()} RWF (${t.type})`).join('\n')}\n\nYou can view them in the Transactions tab.`
				const successId = await saveMessage('assistant', successContent)
				
				const successMsg: Message = {
					id: successId,
					role: 'assistant',
					content: successContent,
					timestamp: new Date()
				}
				setAllMessages((prev) => [...prev, successMsg])
				setMessages((prev) => [...prev, successMsg])
				
				// Dispatch event to notify other components (like DashboardShell) to refresh
				window.dispatchEvent(new CustomEvent('refreshTransactions', { 
					detail: { count: data.transactionsCreated.length, source: 'ai_chat' } 
				}))
			}

			// If inventory items were created, add a success message
			if (data.itemsCreated && data.itemsCreated.length > 0) {
				const successContent = `✅ Successfully ${data.itemsCreated.some((i: any) => i.updated) ? 'updated' : 'added'} ${data.itemsCreated.length} inventory item(s):\n${data.itemsCreated.map((i: any) => `• ${i.name}${i.updated ? ' (updated)' : ''}`).join('\n')}\n\nYou can view them in the Inventory tab.`
				const successId = await saveMessage('assistant', successContent)
				
				const successMsg: Message = {
					id: successId,
					role: 'assistant',
					content: successContent,
					timestamp: new Date()
				}
				setAllMessages((prev) => [...prev, successMsg])
				setMessages((prev) => [...prev, successMsg])

				// Show financial recording prompt if items have prices
				const itemsWithPrices = data.itemsCreated.filter((i: any) => i.unitPrice > 0)
				if (itemsWithPrices.length > 0) {
					const totalAmount = itemsWithPrices.reduce((sum: number, i: any) => sum + (i.unitPrice * i.quantity), 0)
					setPendingFinancialRecord({ items: itemsWithPrices, totalAmount })
				}
			}

			// If inventory sales were recorded, add a detailed message
			if (data.salesResults && data.salesResults.length > 0) {
				const successItems = data.salesResults.filter((s: any) => !s.error)
				const errorItems = data.salesResults.filter((s: any) => s.error)
				
				let successContent = ''
				if (successItems.length > 0) {
					successContent = `✅ Successfully recorded ${successItems.length} sale(s):\n${successItems.map((s: any) => {
						const stockInfo = s.newQuantity < 0 
							? `⚠️ NEGATIVE STOCK: ${s.newQuantity} ${s.unit} (${Math.abs(s.newQuantity)} ${s.unit} short)`
							: `Stock: ${s.oldQuantity} → ${s.newQuantity} ${s.unit}`
						return `• ${s.quantity} ${s.unit} ${s.name} - ${s.totalAmount.toLocaleString()} RWF${s.customerName ? ` (${s.customerName})` : ''}\n  ${stockInfo}`
					}).join('\n')}`
				}
				
				if (errorItems.length > 0) {
					successContent += `\n\n❌ Errors:\n${errorItems.map((e: any) => `• ${e.name}: ${e.error}`).join('\n')}`
				}
				
				if (successContent) {
					const successId = await saveMessage('assistant', successContent)
					const successMsg: Message = {
						id: successId,
						role: 'assistant',
						content: successContent,
						timestamp: new Date()
					}
					setAllMessages((prev) => [...prev, successMsg])
					setMessages((prev) => [...prev, successMsg])
					
					// Dispatch event to notify other components to refresh
					if (successItems.length > 0) {
						window.dispatchEvent(new CustomEvent('refreshTransactions', { 
							detail: { count: successItems.length, source: 'inventory_sale' } 
						}))
					}
				}
			}

			// If inventory purchases were recorded, add a detailed message
			if (data.purchaseResults && data.purchaseResults.length > 0) {
				const successItems = data.purchaseResults.filter((p: any) => !p.error)
				const errorItems = data.purchaseResults.filter((p: any) => p.error)
				
				let successContent = ''
				if (successItems.length > 0) {
					successContent = `✅ Successfully recorded ${successItems.length} purchase(s):\n${successItems.map((p: any) => 
						`• ${p.quantity} ${p.unit} ${p.name} - ${p.totalCost.toLocaleString()} RWF\n  Stock: ${p.oldQuantity} → ${p.newQuantity} ${p.unit}`
					).join('\n')}`
				}
				
				if (errorItems.length > 0) {
					successContent += `\n\n❌ Errors:\n${errorItems.map((e: any) => `• ${e.name}: ${e.error}`).join('\n')}`
				}
				
				if (successContent) {
					const successId = await saveMessage('assistant', successContent)
					const successMsg: Message = {
						id: successId,
						role: 'assistant',
						content: successContent,
						timestamp: new Date()
					}
					setAllMessages((prev) => [...prev, successMsg])
					setMessages((prev) => [...prev, successMsg])
					
					// Dispatch event to notify other components to refresh
					if (successItems.length > 0) {
						window.dispatchEvent(new CustomEvent('refreshTransactions', { 
							detail: { count: successItems.length, source: 'inventory_purchase' } 
						}))
					}
				}
			}

			// If new inventory items were added and purchased in one action, show details and refresh reports
			if (data.addAndPurchaseResults && data.addAndPurchaseResults.length > 0) {
				const successItems = data.addAndPurchaseResults.filter((p: any) => !p.error)
				const errorItems = data.addAndPurchaseResults.filter((p: any) => p.error)

				let successContent = ''
				if (successItems.length > 0) {
					successContent = `✅ Successfully added and recorded ${successItems.length} inventory purchase(s):\n${successItems.map((p: any) =>
						`• ${p.quantity} ${p.unit} ${p.name}${p.totalCost ? ` - ${p.totalCost.toLocaleString()} RWF` : ''}\n  Stock is now ${p.newQuantity} ${p.unit}`
					).join('\n')}`
				}

				if (errorItems.length > 0) {
					successContent += `\n\n❌ Errors:\n${errorItems.map((e: any) => `• ${e.name}: ${e.error}`).join('\n')}`
				}

				if (successContent) {
					const successId = await saveMessage('assistant', successContent)
					const successMsg: Message = {
						id: successId,
						role: 'assistant',
						content: successContent,
						timestamp: new Date()
					}
					setAllMessages((prev) => [...prev, successMsg])
					setMessages((prev) => [...prev, successMsg])

					if (successItems.length > 0) {
						window.dispatchEvent(new CustomEvent('refreshTransactions', {
							detail: { count: successItems.length, source: 'inventory_add_and_purchase' }
						}))
					}
				}
			}
		} catch (e: any) {
			const raw = e?.message || ''
			const errorMessage =
				raw.includes('fetch') || raw.includes('network') || raw.includes('Failed to fetch')
					? "Can't reach the server right now. Check your internet connection and try again."
					: raw.length > 0 && raw.length < 200
						? raw
						: "Something went wrong on our end. Give it another try."

			setError(errorMessage)
			
			// Add error message to chat instead of just showing in error banner
			const errorMsg: Message = {
				id: `error-${Date.now()}`,
				role: 'assistant',
				content: errorMessage,
				timestamp: new Date()
			}
			setMessages((prev) => [...prev.filter(msg => msg.id !== tempUserId), errorMsg])
		} finally {
			setLoadingPhase('')
			setLoading(false)
		}
	}

	function startNewConversation() {
		setConversationMode('new')
		setSelectedDate('all')
		setError(null)
		setInput('')
		setSelectedImages([])
		setPendingFinancialRecord(null)
		localStorage.removeItem('aiChatDraft')
		setMessages(createWelcomeMessage())
	}

	const latestAssistantMessage = [...messages].reverse().find((msg) => msg.role === 'assistant')
	const showSharedQuotaBanner = Boolean(latestAssistantMessage && isSharedQuotaMessage(latestAssistantMessage.content))

	function handleKeyPress(e: React.KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			sendMessage()
		}
	}

	function handlePaste(e: React.ClipboardEvent) {
		const items = e.clipboardData?.items
		if (!items) return

		const imageFiles: File[] = []
		for (let i = 0; i < items.length; i++) {
			const item = items[i]
			if (item.type.startsWith('image/')) {
				const file = item.getAsFile()
				if (file) {
					// Validate file size (max 10MB like our upload endpoint)
					const maxSize = 10 * 1024 * 1024 // 10MB
					if (file.size > maxSize) {
						setError('Image is too large. Maximum size is 10MB.')
						continue
					}
					imageFiles.push(file)
				}
			}
		}

		if (imageFiles.length > 0) {
			// Limit to 5 images total
			const availableSlots = 5 - selectedImages.length
			const newImages = imageFiles.slice(0, availableSlots)
			if (newImages.length > 0) {
				setSelectedImages(prev => [...prev, ...newImages])
				// Clear any previous errors
				if (newImages.length === imageFiles.length) {
					setError(null)
				}
			}
			if (imageFiles.length > availableSlots) {
				setError(`Only ${availableSlots} more image(s) can be added (maximum 5 total)`)
			}
		}
	}

	return (
		<div className="flex h-full overflow-hidden">

			{/* ── Left Sidebar ── */}
			<div className="w-52 flex-shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col overflow-hidden">
				{/* New Conversation */}
				<div className="p-3 border-b border-gray-200">
					<button
						onClick={startNewConversation}
						className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-orange-500 text-white text-sm font-semibold hover:bg-orange-600 transition-colors shadow-sm"
					>
						<span className="text-base leading-none">+</span>
						New Conversation
					</button>
				</div>

				{/* Search */}
				<div className="px-3 py-2 border-b border-gray-200">
					<input
						type="text"
						placeholder="Search by date or title..."
						className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-orange-400 placeholder-gray-400"
						readOnly
					/>
				</div>

				{/* History list */}
				<div className="flex-1 overflow-y-auto py-2 px-2">
					<p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-2 mb-2">Conversation History</p>
					{loadingHistory ? (
						<p className="text-xs text-gray-400 px-2">Loading...</p>
					) : (() => {
						const dateGroups = allMessages.reduce((acc, msg) => {
							const date = new Date(msg.timestamp).toISOString().split('T')[0]
							if (!acc[date]) acc[date] = []
							acc[date].push(msg)
							return acc
						}, {} as Record<string, Message[]>)
						const sortedDates = Object.keys(dateGroups).sort((a, b) => b.localeCompare(a))
						if (sortedDates.length === 0) return (
							<p className="text-xs text-gray-400 px-2">No history yet</p>
						)
						return sortedDates.map(date => {
							const msgs = dateGroups[date]
							const label = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
							const preview = msgs.find((m: Message) => m.role === 'user')?.content?.slice(0, 36) ?? 'Chat session'
							return (
								<button
									key={date}
									onClick={() => {
										setConversationMode('history')
										setSelectedDate(date)
										setError(null)
									}}
									className={`w-full text-left px-3 py-2 rounded-lg mb-0.5 transition-colors ${
										selectedDate === date
											? 'bg-orange-100 border border-orange-200'
											: 'hover:bg-gray-100'
									}`}
								>
									<div className="flex items-center justify-between">
										<span className="text-xs font-semibold text-gray-700">{label}</span>
										<span className="text-[10px] text-gray-400">{msgs.length}</span>
									</div>
									<p className="text-[11px] text-gray-500 truncate mt-0.5">{preview}</p>
								</button>
							)
						})
					})()}
				</div>
			</div>

			{/* ── Right Chat Panel ── */}
			<div className="flex-1 flex flex-col min-w-0 overflow-hidden">
			<div className="flex-1 flex flex-col space-y-3 p-4 overflow-hidden">

			{/* Chat Messages */}
			<div className="flex-1 overflow-y-auto rounded-lg border bg-white shadow-sm">
 {loadingHistory ? (
					<div className="flex h-full items-center justify-center text-sm text-gray-500">
						{t.chat.loadingHistory}
					</div>
				) : (
					<div className="space-y-4 p-4">
						{messages.map((msg, index) => {
							// Check if this message is from a different day than the previous message
							const showDateSeparator = index === 0 || 
								new Date(messages[index - 1].timestamp).toDateString() !== new Date(msg.timestamp).toDateString()
							
							// Format date as "Day, Month Date, Year" (e.g., "Thursday, February 13, 2026")
							const dateString = new Date(msg.timestamp).toLocaleDateString('en-US', {
								weekday: 'long',
								year: 'numeric',
								month: 'long',
								day: 'numeric'
							})

							return (
								<div key={msg.id}>
									{/* Date Separator */}
									{showDateSeparator && (
										<div className="flex items-center justify-center py-4">
											<div className="flex items-center gap-3">
												<div className="h-px w-12 bg-gray-300"></div>
												<span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
													{dateString}
												</span>
												<div className="h-px w-12 bg-gray-300"></div>
											</div>
										</div>
									)}
									
									{/* Message */}
									<div
										className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
									>
										<div
											className={`flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full ${
												msg.role === 'user'
													? 'bg-orange-100 text-orange-600'
													: 'text-orange-500'
											}`}
										>
											{msg.role === 'user' ? (
												<User className="h-4 w-4" />
											) : (
												<Sparkles className="h-4 w-4 text-orange-600" />
											)}
										</div>
										<div
											className={`max-w-[70%] rounded-lg px-4 py-3 ${
												msg.role === 'user'
											? 'bg-orange-600 text-white'
													: isSharedQuotaMessage(msg.content)
														? 'border border-amber-200 bg-amber-50 text-amber-900'
														: 'bg-gray-100 text-gray-900'
											}`}
										>
											{/* Images if present */}
											{msg.images && msg.images.length > 0 && (
												<div className="mb-3 flex flex-wrap gap-2">
													{msg.images.map((imagePath, idx) => (
														<img
															key={idx}
															src={imagePath}
															alt={`Uploaded image ${idx + 1}`}
															className="max-h-60 rounded-lg object-contain"
															onClick={() => window.open(imagePath, '_blank')}
															style={{ cursor: 'pointer' }}
														/>
													))}
												</div>
											)}
											
										{renderMessageContent(
											msg.role === 'assistant' && msg.id === typingMessageId
												? typingText
												: msg.content
										)}
										{msg.role === 'assistant' && msg.id === typingMessageId && (
											<span className="inline-block w-[2px] h-[14px] bg-gray-500 ml-0.5 align-middle animate-pulse rounded-sm" />
										)}
										{msg.role === 'assistant' && isSharedQuotaMessage(msg.content) && (
											<div className="mt-3 rounded-lg border border-amber-200 bg-white/80 px-3 py-2 text-xs text-amber-700">
												Shared service issue: Jesse AI is using the app's shared service capacity, not a per-user daily limit.
											</div>
										)}
											<p
												className={`mt-1 text-xs ${
													msg.role === 'user' ? 'text-orange-200' : 'text-gray-500'
												}`}
											>
												{msg.timestamp.toLocaleTimeString()}
											</p>
										</div>
									</div>
								</div>
							)})}
						{showSharedQuotaBanner && (
							<div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
								<div className="flex items-start gap-3">
									<AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
									<div>
										<p className="font-semibold">AI Keys Temporarily Unavailable</p>
										<p className="mt-1 text-xs text-amber-700">Jesse AI is temporarily unavailable because the shared service is currently hitting quota or rate limits. This is not based only on your personal usage. Try again later.</p>
									</div>
								</div>
							</div>
						)}
						{loading && (
							<div className="flex gap-3">
								<div className="flex h-8 w-8 shrink-0 items-center justify-center text-orange-500">
									<Sparkles className="h-4 w-4" />
								</div>
								<div className="rounded-lg bg-gray-100 px-4 py-2.5 flex items-center gap-2">
									{loadingPhase ? (
										<span className="text-sm text-gray-500 italic animate-pulse">{loadingPhase}</span>
									) : null}
									<div className="flex gap-1">
										<div className="h-2 w-2 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: '0ms' }}></div>
										<div className="h-2 w-2 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: '150ms' }}></div>
										<div className="h-2 w-2 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: '300ms' }}></div>
									</div>
								</div>
							</div>
						)}
						{/* Invisible element at the bottom for auto-scrolling */}
						<div ref={messagesEndRef} />
					</div>
				)}
			</div>

			{/* Financial recording prompt card — appears after AI records inventory from image */}
			{pendingFinancialRecord && !loading && (
				<div className="rounded-xl border border-orange-200 bg-orange-50 p-4 shadow-sm">
					<div className="flex items-start gap-3">
						<div className="p-1.5 bg-orange-100 rounded-lg flex-shrink-0">
							<BarChart2 className="h-4 w-4 text-orange-600" />
						</div>
						<div className="flex-1 min-w-0">
							<p className="text-sm font-semibold text-gray-800">Record as purchase expense?</p>
							<p className="text-xs text-gray-500 mt-0.5">
								Would you like me to also record these {pendingFinancialRecord.items.length} item(s) as a purchase expense in your financial reports and transactions?
								{pendingFinancialRecord.totalAmount > 0 && (
									<span className="font-medium text-orange-700"> Total: RWF {pendingFinancialRecord.totalAmount.toLocaleString()}</span>
								)}
							</p>
							<div className="flex gap-2 mt-3">
								<button
									onClick={() => {
										const items = pendingFinancialRecord.items
										setPendingFinancialRecord(null)
										const summary = items.map(i => `${i.quantity} ${i.unit || 'units'} of ${i.name} at RWF ${i.unitPrice} each`).join(', ')
										sendMessage(`Yes, please also record those inventory items as a purchase expense in my financial reports and transactions. Items: ${summary}`)
									}}
									className="px-4 py-1.5 bg-orange-500 text-white rounded-lg text-xs font-semibold hover:bg-orange-600 transition-colors shadow-sm"
								>
									Yes, record it
								</button>
								<button
									onClick={() => setPendingFinancialRecord(null)}
									className="px-4 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-xs font-medium hover:bg-gray-100 transition-colors"
								>
									No thanks
								</button>
							</div>
						</div>
					</div>
				</div>
			)}

			{error && (
				<div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
					{error}
				</div>
			)}

			{/* Input Area */}
			<div className="rounded-lg border bg-white p-4 shadow-sm">
				{/* Image Previews */}
				{selectedImages.length > 0 && (
					<div className="mb-3 flex flex-wrap gap-2">
						{selectedImages.map((file, index) => (
							<div key={index} className="relative">
								<img
									src={URL.createObjectURL(file)}
									alt={`Preview ${index + 1}`}
									className="h-20 w-20 rounded-lg object-cover"
								/>
								<button
									onClick={() => removeImage(index)}
									className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600"
								>
									<X className="h-4 w-4" />
								</button>
							</div>
						))}
					</div>
				)}
				
				<div className="flex gap-2">
					{/* Image Upload Button */}
					<input
						ref={fileInputRef}
						type="file"
						accept="image/*"
						multiple
						onChange={handleImageSelect}
						className="hidden"
					/>
					{/* Excel Import Button */}
					<input
						ref={excelInputRef}
						type="file"
						accept=".xlsx,.xls,.csv"
						onChange={handleExcelUpload}
						className="hidden"
					/>
					<button
						onClick={() => fileInputRef.current?.click()}
						disabled={loading || selectedImages.length >= 5}
						className="flex h-fit items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
						title="Upload images"
					>
						<span className="text-lg font-bold">+</span>
						<ImageIcon className="h-4 w-4" />
					</button>
					<button
						onClick={() => excelInputRef.current?.click()}
						disabled={loading}
						className="flex h-fit items-center gap-2 rounded-md border border-green-300 bg-white px-3 py-2 text-sm font-medium text-green-700 hover:bg-green-50 disabled:cursor-not-allowed disabled:opacity-50"
						title="Import Excel / CSV file"
					>
						<Sheet className="h-4 w-4" />
					</button>
					
					<textarea
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyPress={handleKeyPress}						onPaste={handlePaste}						placeholder={t.chat.typeMessage}
						rows={3}
						className="flex-1 resize-none rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
						disabled={loading}
					/>
					<button
						onClick={() => sendMessage()}
						disabled={((!input.trim() && selectedImages.length === 0) || loading)}
						className="flex h-fit items-center gap-2 rounded-md bg-gradient-to-r from-orange-500 to-red-600 px-4 py-2 text-sm font-medium text-white hover:from-orange-600 hover:to-red-700 disabled:cursor-not-allowed disabled:opacity-50"
					>
						<Send className="h-4 w-4" />
						{t.chat.send}
					</button>
				</div>
				<p className="mt-2 text-xs text-gray-500">
				Press Enter to send, Shift+Enter for new line • Ctrl+V to paste images • Max 5 images • Green button imports Excel/CSV
			</p>
		</div>

			</div>
			</div>
		</div>
	)
}

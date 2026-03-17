'use client'

import React, { useState, useEffect, useRef } from 'react'
import {
	MessageCircle, Send, User, Calendar, Image as ImageIcon, X, Sparkles,
	TrendingUp, TrendingDown, CheckCircle, XCircle, AlertTriangle,
	Lightbulb, Target, Flame, Zap, Users, Clock, Banknote, Star,
	ArrowRight, ChefHat, Award, BarChart2
} from 'lucide-react'
import { useLanguage } from '@/contexts/LanguageContext'

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

export default function AIChat() {
	const { t } = useLanguage()
	const [messages, setMessages] = useState<Message[]>([])
	const [allMessages, setAllMessages] = useState<Message[]>([])
	const [input, setInput] = useState('')
	const [selectedImages, setSelectedImages] = useState<File[]>([])
	const [loading, setLoading] = useState(false)
	const [loadingHistory, setLoadingHistory] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [selectedDate, setSelectedDate] = useState<string>('all')
	const [showDatePicker, setShowDatePicker] = useState(false)
	const [pendingFinancialRecord, setPendingFinancialRecord] = useState<PendingFinancialRecord | null>(null)
	const messagesEndRef = useRef<HTMLDivElement>(null)
	const fileInputRef = useRef<HTMLInputElement>(null)

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
	}, [selectedDate, allMessages])

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
					setMessages(loadedMessages)
				} else {
					// Show welcome message if no history
					const welcomeMsg = [{
						id: '1',
						role: 'assistant' as const,
						content: "Hi! I'm Jesse, your accounting AI assistant. I can help you with:\n\n• **Upload images** 📷 - Send receipts, invoices, or bills and I'll automatically extract and record transactions!\n  - Just click the image icon and upload\n  - I'll read the document and create proper journal entries\n  - Works with photos, scans, or screenshots\n\n• **Record transactions** - Single or multiple transactions with different dates and accounts:\n  - Single: \"Record 50,000 fuel expense on Jan 15\"\n  - Batch: \"Jan 10: received 200,000 from client, Jan 12: paid 80,000 rent, Jan 15: 45,000 diesel\"\n  - Natural: \"Yesterday I paid 40,000 for parking and 25,000 for lunch\"\n  - Sequential: \"Record driver payment 60,000 on Jan 5, diesel 45,000 on Jan 6, repair 120,000 on Jan 7\"\n\n• **Product sales** - If you add products to Inventory, I can automatically calculate revenue:\n  - \"Sold 5 bags of cement today\"\n  - \"Customer bought 20kg of diesel\"\n  - I'll look up the price from your inventory and record the sale!\n\n• **Create adjusting entries** - Depreciation, accruals, deferrals, and corrections\n\n• **Understand your finances** - Ask about your cash balance, revenue, expenses, profit, or account balances\n\n• **Explain accounting concepts** - Questions about debits, credits, accounts payable, receivables, financial statements, etc.\n\n**Important:**\n- I can handle multiple transactions at once with different dates and accounts!\n- Just separate them with commas, \"and\", or list them\n- I automatically detect the right accounts based on the transaction type\n- Upload images of receipts and invoices for automatic processing!\n- Add products in the Inventory tab to enable automatic sales tracking\n- I only answer accounting-related questions\n- I cannot delete transactions (use the Delete button in the Journal section)\n\nWhat can I help you with today?",
						timestamp: new Date()
					}]
					setAllMessages(welcomeMsg)
					setMessages(welcomeMsg)
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

			// Send to AI
			const res = await fetch('/api/ai/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					message: userContent || 'Please analyze this image',
					images: uploadedImagePaths,
					conversationHistory: messages.slice(-50) // Last 50 messages for context (increased memory)
				})
			})

			if (!res.ok) {
				const errBody = await res.json().catch(() => ({}))
				const errMsg = errBody?.error || errBody?.message || ''
				if (errMsg.toLowerCase().includes('gemini') || errMsg.toLowerCase().includes('api key')) {
					throw new Error('⚙️ Gemini API key is not configured. Go to **AI Analytics** tab and enter your key to enable AI features.')
				}
				throw new Error("I'm sorry, I encountered an issue. Please try again.")
			}

			const data = await res.json()

			// Check if there's an error in the response
			if (data.error) {
				throw new Error("I'm sorry, I encountered an issue. Please try again.")
			}

			// Save AI response to database
			let aiContent = data.response || "I couldn't generate a response. Could you please rephrase your question?"
			
			// Clean up any HTML or technical content that might have slipped through
			if (aiContent.includes('<html') || aiContent.includes('<!DOCTYPE')) {
				aiContent = "I'm sorry, I can't help with that right now. Please try asking in a different way or contact support if the issue persists."
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
		} catch (e: any) {
			// Show user-friendly error message
			const errorMessage = e?.message?.includes('fetch') || e?.message?.includes('network')
				? "I'm having trouble connecting. Please check your internet connection and try again."
				: e?.message || "I'm sorry, something went wrong. Please try again."
			
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
			setLoading(false)
		}
	}

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
						onClick={() => setSelectedDate('all')}
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
									onClick={() => setSelectedDate(date)}
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
													: 'bg-white p-0.5'
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
											
										{renderMessageContent(msg.content)}
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
						{loading && (
							<div className="flex gap-3">
								<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-red-600">
									<Sparkles className="h-4 w-4 text-white" />
								</div>
								<div className="rounded-lg bg-gray-100 px-4 py-2">
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
					<button
						onClick={() => fileInputRef.current?.click()}
						disabled={loading || selectedImages.length >= 5}
						className="flex h-fit items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
						title="Upload images"
					>
						<span className="text-lg font-bold">+</span>
						<ImageIcon className="h-4 w-4" />
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
				Press Enter to send, Shift+Enter for new line • Ctrl+V to paste images • Max 5 images
			</p>
		</div>

			{/* Quick Actions */}
			<div className="rounded-lg border border-orange-200 bg-orange-50 p-3">
				<h4 className="mb-2 text-xs font-bold text-orange-900 uppercase tracking-wide">Quick Actions:</h4>
				<div className="flex flex-wrap gap-2">
					<button
						onClick={() => sendMessage("Let's talk about my analytics. What do you see?")}
						className="rounded-md bg-gradient-to-r from-orange-500 to-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:from-orange-600 hover:to-red-700 shadow-sm"
					>
						Analyse My Business
					</button>
					<button
						onClick={() => sendMessage("I need marketing ideas to bring more customers in. Can you help me figure out what's going on and suggest a campaign?")}
						className="rounded-md bg-gradient-to-r from-orange-500 to-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:from-orange-600 hover:to-red-700 shadow-sm"
					>
						🔥 Marketing Ideas
					</button>
					<button
						onClick={() => setInput('What adjusting entries would you like me to record?')}
						className="rounded-md bg-white border border-orange-200 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100"
					>
						Create Adjustment
					</button>
					<button
						onClick={() => setInput('Explain my current financial position')}
						className="rounded-md bg-white border border-orange-200 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100"
					>
						Explain Finances
					</button>
					<button
						onClick={() => setInput('What transactions happened this week?')}
						className="rounded-md bg-white border border-orange-200 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100"
					>
						This Week's Activity
					</button>
					<button
						onClick={() => setInput('What is my current cash balance?')}
						className="rounded-md bg-white border border-orange-200 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100"
					>
						Cash Balance
					</button>
				</div>
			</div>
			</div>
			</div>
		</div>
	)
}

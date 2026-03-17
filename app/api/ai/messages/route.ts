import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// GET: Retrieve chat messages for the current user
export async function GET(req: NextRequest) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const userId = session.user.id

		// Get query parameters
		const searchParams = req.nextUrl.searchParams
		const limit = parseInt(searchParams.get('limit') || '100')

		// Fetch recent messages
		const messages = await prisma.chatMessage.findMany({
			where: { userId },
			orderBy: { createdAt: 'desc' },
			take: limit
		})

		// Return in chronological order (oldest first)
		return NextResponse.json({
			messages: messages.reverse().map((msg: any) => ({
				id: msg.id,
				role: msg.role,
				content: msg.content,
				images: msg.images ? JSON.parse(msg.images) : undefined,
				timestamp: msg.createdAt
			}))
		})
	} catch (error: any) {
		console.error('Error fetching chat messages:', error)
		return NextResponse.json(
			{ error: error.message || 'Failed to fetch messages' },
			{ status: 500 }
		)
	}
}

// POST: Save a new chat message
export async function POST(req: NextRequest) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const userId = session.user.id
		const body = await req.json()
		const { role, content, images } = body

		if (!role || !content) {
			return NextResponse.json(
				{ error: 'Role and content are required' },
				{ status: 400 }
			)
		}

		if (role !== 'user' && role !== 'assistant') {
			return NextResponse.json(
				{ error: 'Role must be either "user" or "assistant"' },
				{ status: 400 }
			)
		}

		// Save message to database
		const message = await prisma.chatMessage.create({
			data: {
				userId,
				role,
				content,
				images: images && images.length > 0 ? JSON.stringify(images) : null
			} as any
		})

		return NextResponse.json({
			message: {
				id: message.id,
				role: message.role,
				content: message.content,
				images: (message as any).images ? JSON.parse((message as any).images) : undefined,
				timestamp: message.createdAt
			}
		})
	} catch (error: any) {
		console.error('Error saving chat message:', error)
		return NextResponse.json(
			{ error: error.message || 'Failed to save message' },
			{ status: 500 }
		)
	}
}

// DELETE: DISABLED - Chat messages are permanently saved and cannot be deleted
// This ensures complete audit trail and conversation history is preserved
export async function DELETE() {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		// DELETION DISABLED - Chats are permanently saved
		// await prisma.chatMessage.deleteMany({
		// 	where: { userId }
		// })

		return NextResponse.json({ 
			error: 'Chat deletion is disabled. All conversations are permanently saved for record-keeping.' 
		}, { status: 403 })
	} catch (error: any) {
		console.error('Error in DELETE request:', error)
		return NextResponse.json(
			{ error: 'Chat deletion is disabled' },
			{ status: 403 }
		)
	}
}

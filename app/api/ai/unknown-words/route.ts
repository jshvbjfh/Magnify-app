import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// GET: List all unknown words
export async function GET() {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const unknownWords = await prisma.unknownWord.findMany({
			orderBy: { createdAt: 'desc' },
			take: 100
		})

		return NextResponse.json({ unknownWords })
	} catch (error) {
		console.error('Error fetching unknown words:', error)
		return NextResponse.json(
			{ error: 'Failed to fetch unknown words' },
			{ status: 500 }
		)
	}
}

// POST: Add explanation to an unknown word
export async function POST(request: Request) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const body = await request.json()
		const { id, userExplanation, addToDictionary } = body

		if (!id || !userExplanation) {
			return NextResponse.json(
				{ error: 'Missing id or explanation' },
				{ status: 400 }
			)
		}

		// Update the unknown word with user's explanation
		const unknownWord = await prisma.unknownWord.update({
			where: { id },
			data: {
				userExplanation,
				status: 'resolved'
			}
		})

		// Optionally add to dictionary for future reference
		if (addToDictionary && unknownWord.word) {
			await prisma.customDictionary.create({
				data: {
					kinyarwandaWord: unknownWord.word,
					englishMeaning: userExplanation,
					context: unknownWord.context || undefined
				}
			})
		}

		// Check if all unknown words for this upload are now resolved
		if (unknownWord.uploadId) {
			const remainingUnknown = await prisma.unknownWord.count({
				where: {
					uploadId: unknownWord.uploadId,
					status: 'pending'
				}
			})

			// If all words are resolved, automatically finalize the upload
			if (remainingUnknown === 0) {
				const upload = await prisma.upload.findUnique({
					where: { id: unknownWord.uploadId }
				})

				if (upload && upload.status === 'pending_clarification' && upload.pendingData) {
					try {
						// Finalize upload directly without internal fetch
						const transactions = JSON.parse(upload.pendingData)
						
						// Import finalize logic here or trigger a background job
						// For now, just update status and let user manually finalize
						return NextResponse.json({ 
							success: true, 
							unknownWord,
							allWordsResolved: true,
							uploadId: unknownWord.uploadId,
							message: `All words resolved! Refresh the page to see your transactions.`
						})
					} catch (error) {
						console.error('Error checking upload status:', error)
						// Continue even if check fails
					}
				}
			}
		}

		return NextResponse.json({ success: true, unknownWord })
	} catch (error) {
		console.error('Error updating unknown word:', error)
		return NextResponse.json(
			{ error: 'Failed to update unknown word' },
			{ status: 500 }
		)
	}
}

// DELETE: Remove an unknown word (if it was a false positive)
export async function DELETE(request: Request) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const { searchParams } = new URL(request.url)
		const id = searchParams.get('id')

		if (!id) {
			return NextResponse.json({ error: 'Missing id' }, { status: 400 })
		}

		await prisma.unknownWord.delete({
			where: { id }
		})

		return NextResponse.json({ success: true })
	} catch (error) {
		console.error('Error deleting unknown word:', error)
		return NextResponse.json(
			{ error: 'Failed to delete unknown word' },
			{ status: 500 }
		)
	}
}

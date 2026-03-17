import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function PATCH(
	request: Request,
	{ params }: { params: { id: string } }
) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const body = await request.json()
		const transactionId = params.id

		// Get the transaction to find its pair
		const transaction = await prisma.transaction.findUnique({
			where: { id: transactionId }
		})

		if (!transaction) {
			return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
		}

		// Check if this is a full update or just payment method
		if (body.fullUpdate) {
			// Full transaction update
			const { direction, amount, description, date, categoryType, accountName, paymentMethod } = body
			
			if (!amount || amount <= 0) {
				return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
			}

			// Parse amount and date
			const parsedAmount = parseFloat(amount)
			const parsedDate = date ? new Date(date) : new Date()

			// If transaction has a pair, update both
			if (transaction.pairId) {
				// Get both transactions in the pair
				const pairTransactions = await prisma.transaction.findMany({
					where: { pairId: transaction.pairId },
					include: { account: true }
				})

				// Update both transactions with new values
				for (const tx of pairTransactions) {
					await prisma.transaction.update({
						where: { id: tx.id },
						data: {
							amount: parsedAmount,
							description: description || tx.description,
							date: parsedDate,
							paymentMethod: paymentMethod || tx.paymentMethod
						}
					})
				}
			} else {
				// Single transaction update
				await prisma.transaction.update({
					where: { id: transactionId },
					data: {
						amount: parsedAmount,
						description: description || transaction.description,
						date: parsedDate,
						paymentMethod: paymentMethod || transaction.paymentMethod
					}
				})
			}

			return NextResponse.json({ success: true, message: 'Transaction updated successfully' })
		} else {
			// Just payment method update (original functionality)
			const { paymentMethod } = body

			if (!paymentMethod || !['Cash', 'Bank', 'Mobile Money', 'Owner Momo', 'Credit', 'Other'].includes(paymentMethod)) {
				return NextResponse.json(
					{ error: 'Invalid payment method. Must be Cash, Bank, Mobile Money, Owner Momo, Credit, or Other' },
					{ status: 400 }
				)
			}

			// Update both this transaction and its pair (if it has one)
			if (transaction.pairId) {
				await prisma.transaction.updateMany({
					where: {
						pairId: transaction.pairId
					},
					data: {
						paymentMethod
					}
				})
			} else {
				// Just update this single transaction
				await prisma.transaction.update({
					where: { id: transactionId },
					data: { paymentMethod }
				})
			}

			return NextResponse.json({ success: true })
		}
	} catch (error) {
		console.error('Error updating transaction:', error)
		return NextResponse.json(
			{ error: 'Failed to update transaction' },
			{ status: 500 }
		)
	}
}

export async function DELETE(
	request: Request,
	{ params }: { params: { id: string } }
) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const transactionId = params.id

		// Get the transaction to find its pair
		const transaction = await prisma.transaction.findUnique({
			where: { id: transactionId }
		})

		if (!transaction) {
			return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
		}

		// Delete both this transaction and its pair (if it has one)
		// This ensures double-entry bookkeeping integrity
		if (transaction.pairId) {
			await prisma.transaction.deleteMany({
				where: {
					pairId: transaction.pairId
				}
			})
		} else {
			// Just delete this single transaction
			await prisma.transaction.delete({
				where: { id: transactionId }
			})
		}

		return NextResponse.json({ success: true, message: 'Transaction deleted successfully' })
	} catch (error) {
		console.error('Error deleting transaction:', error)
		return NextResponse.json(
			{ error: 'Failed to delete transaction' },
			{ status: 500 }
		)
	}
}

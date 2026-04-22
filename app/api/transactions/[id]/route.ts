import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

const VALID_PAYMENT_METHODS = ['Cash', 'Bank', 'Mobile Money', 'Owner Momo', 'Credit', 'Notes Payable', 'Other']

function buildTransactionScopeFilter(restaurantId: string | null, branchId: string | null) {
	if (!restaurantId) return {}
	return { restaurantId, branchId }
}

async function resolveAuthorizedTransaction(userId: string, transactionId: string) {
	const context = await getRestaurantContextForUser(userId)
	const billingUserId = context?.billingUserId ?? userId
	const restaurantId = context?.restaurantId ?? null
	const branchId = context?.branchId ?? null

	const transaction = await prisma.transaction.findFirst({
		where: {
			id: transactionId,
			userId: billingUserId,
			...buildTransactionScopeFilter(restaurantId, branchId),
		},
	})

	return { context, billingUserId, restaurantId, branchId, transaction }
}

async function resolveAuthorizedPairIds(billingUserId: string, restaurantId: string | null, branchId: string | null, pairId: string) {
	const pairTransactions = await prisma.transaction.findMany({
		where: {
			pairId,
			userId: billingUserId,
			...buildTransactionScopeFilter(restaurantId, branchId),
		},
		select: { id: true, description: true, paymentMethod: true },
	})

	return pairTransactions
}

export async function PATCH(
	request: Request,
	{ params }: { params: Promise<{ id: string }> }
) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const body = await request.json()
		const transactionId = (await params).id
		const { billingUserId, restaurantId, branchId, transaction } = await resolveAuthorizedTransaction(session.user.id, transactionId)

		if (!transaction) {
			return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
		}

		if (!transaction.isManual) {
			return NextResponse.json({ error: 'System-generated transactions cannot be edited here' }, { status: 403 })
		}

		// Check if this is a full update or just payment method
		if (body.fullUpdate) {
			// Full transaction update
			const { amount, description, date, paymentMethod } = body
			
			if (!amount || amount <= 0) {
				return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
			}

			// Parse amount and date
			const parsedAmount = parseFloat(amount)
			const parsedDate = date ? new Date(date) : new Date()
			if (Number.isNaN(parsedDate.getTime())) {
				return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
			}

			// If transaction has a pair, update both
			if (transaction.pairId) {
				const pairTransactions = await resolveAuthorizedPairIds(billingUserId, restaurantId, branchId, transaction.pairId)
				if (pairTransactions.length === 0) {
					return NextResponse.json({ error: 'Transaction pair not found' }, { status: 404 })
				}

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

			if (!paymentMethod || !VALID_PAYMENT_METHODS.includes(paymentMethod)) {
				return NextResponse.json(
					{ error: 'Invalid payment method. Must be Cash, Bank, Mobile Money, Owner Momo, Credit, Notes Payable, or Other' },
					{ status: 400 }
				)
			}

			// Update both this transaction and its pair (if it has one)
			if (transaction.pairId) {
				const pairTransactions = await resolveAuthorizedPairIds(billingUserId, restaurantId, branchId, transaction.pairId)
				if (pairTransactions.length === 0) {
					return NextResponse.json({ error: 'Transaction pair not found' }, { status: 404 })
				}

				await prisma.transaction.updateMany({
					where: { id: { in: pairTransactions.map((tx) => tx.id) } },
					data: { paymentMethod }
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
	{ params }: { params: Promise<{ id: string }> }
) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const transactionId = (await params).id
		const { billingUserId, restaurantId, branchId, transaction } = await resolveAuthorizedTransaction(session.user.id, transactionId)

		if (!transaction) {
			return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
		}

		if (!transaction.isManual) {
			return NextResponse.json({ error: 'System-generated transactions cannot be deleted here' }, { status: 403 })
		}

		// Delete both this transaction and its pair (if it has one)
		// This ensures double-entry bookkeeping integrity
		if (transaction.pairId) {
			const pairTransactions = await resolveAuthorizedPairIds(billingUserId, restaurantId, branchId, transaction.pairId)
			if (pairTransactions.length === 0) {
				return NextResponse.json({ error: 'Transaction pair not found' }, { status: 404 })
			}

			await prisma.transaction.deleteMany({
				where: {
					id: { in: pairTransactions.map((tx) => tx.id) }
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

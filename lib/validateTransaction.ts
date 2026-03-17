// Validation utility for transaction data before saving
// This prevents invalid data from creating broken accounting records

export interface TransactionValidationResult {
	isValid: boolean
	errors: string[]
	warnings: string[]
}

export function validateTransaction(transaction: any): TransactionValidationResult {
	const errors: string[] = []
	const warnings: string[] = []

	// Critical validations (must pass)
	if (!transaction.direction || (transaction.direction !== 'in' && transaction.direction !== 'out')) {
		errors.push(`Invalid direction: "${transaction.direction}" (must be "in" or "out")`)
	}

	if (!transaction.amount || Number(transaction.amount) <= 0 || !Number.isFinite(Number(transaction.amount))) {
		errors.push(`Invalid amount: "${transaction.amount}" (must be positive number)`)
	}

	if (!transaction.accountName || transaction.accountName.trim() === '' || transaction.accountName === 'NULL' || transaction.accountName === 'Unknown') {
		errors.push(`Missing or invalid account name: "${transaction.accountName}"`)
	}

	if (!transaction.description || transaction.description.trim() === '') {
		errors.push(`Missing description`)
	}

	// Important validations (should warn)
	if (!transaction.date) {
		warnings.push('Missing date (will use current date)')
	}

	if (!transaction.summary) {
		warnings.push('Missing summary (grouping may be affected)')
	}

	if (!transaction.categoryType) {
		warnings.push('Missing categoryType (will infer from direction)')
	}

	return {
		isValid: errors.length === 0,
		errors,
		warnings
	}
}

export function logTransactionValidation(transaction: any, result: TransactionValidationResult, index: number) {
	const status = result.isValid ? '✓' : '✗'
	console.log(`\n${status} Transaction #${index + 1}:`)
	console.log(`  Account: ${transaction.accountName || 'MISSING'}`)
	console.log(`  Direction: ${transaction.direction || 'MISSING'}`)
	console.log(`  Amount: ${transaction.amount || 'MISSING'}`)
	console.log(`  Description: ${transaction.description?.substring(0, 60) || 'MISSING'}`)
	
	if (result.errors.length > 0) {
		console.log(`  ❌ ERRORS:`)
		result.errors.forEach(err => console.log(`     - ${err}`))
	}
	
	if (result.warnings.length > 0) {
		console.log(`  ⚠️  WARNINGS:`)
		result.warnings.forEach(warn => console.log(`     - ${warn}`))
	}
}

export function validateAndFilterTransactions(transactions: any[]): any[] {
	console.log(`\n${'='.repeat(80)}`)
	console.log(`VALIDATING ${transactions.length} EXTRACTED TRANSACTIONS`)
	console.log('='.repeat(80))

	const validTransactions = transactions.filter((t, index) => {
		const result = validateTransaction(t)
		logTransactionValidation(t, result, index)
		return result.isValid
	})

	console.log(`\n${'='.repeat(80)}`)
	console.log(`VALIDATION COMPLETE: ${validTransactions.length}/${transactions.length} transactions valid`)
	console.log(`${'='.repeat(80)}\n`)

	return validTransactions
}

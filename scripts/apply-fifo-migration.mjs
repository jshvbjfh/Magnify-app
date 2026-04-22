console.error([
  'Legacy FIFO raw-SQL patching has been disabled.',
  'This script only knew the pre-cutover FIFO schema and is no longer safe to run.',
  'Use the checked-in Prisma migration for schema changes, then use Restaurant Settings to preview/apply reconciliation and validate cutover.',
  'If you need an emergency local-only recovery path, update this script to match the current migration before executing raw SQL.',
].join('\n'))

process.exitCode = 1

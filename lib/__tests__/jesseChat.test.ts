import { describe, it } from 'vitest'
import { parseIntents } from '@/lib/jesseIntents'

const CONVO: [string, string][] = [
  ['GREETING', 'hi'],
  ['GREETING', 'good evening jesse'],
  ['GREETING', 'muraho'],
  ['SMALL TALK', 'thanks'],
  ['SMALL TALK', 'thank you that helps'],
  ['SMALL TALK', 'ok cool'],
  ['SMALL TALK', 'who are you?'],
  ['SMALL TALK', 'what can you do?'],
  ['SMALL TALK', 'help'],
  ['CATCH UP', "how's business today?"],
  ['CATCH UP', 'give me a summary'],
  ['REVENUE', "what's today's revenue?"],
  ['REVENUE', 'how much did we make yesterday'],
  ['REVENUE', 'sales this month'],
  ['PROFIT', 'are we profitable?'],
  ['PROFIT', 'what is our profit this week'],
  ['PROFIT', 'did we lose money in july'],
  ['MARGIN', "what's our profit margin?"],
  ['MARGIN', 'how much margin do we make on drinks'],
  ['FOOD COST', "what's our food cost percentage"],
  ['EXPENSES', 'how much did we spend on supplies'],
  ['EXPENSES', 'what are our biggest expenses'],
  ['CASHFLOW', 'how much cash do we have'],
  ['CASHFLOW', "what's our cash position"],
  ['CASHFLOW', 'do we have enough money to pay suppliers'],
  ['DEBT', 'who owes us money'],
  ['DEBT', 'how much do we owe suppliers'],
  ['DEBT', 'any unpaid bills'],
  ['STOCK', 'any low stock?'],
  ['STOCK', 'what should i restock'],
  ['STOCK', 'how much soy sauce do we have'],
  ['ORDERS', 'how many orders today'],
  ['ORDERS', 'any pending orders'],
  ['DISHES', 'what are our top dishes'],
  ['DISHES', 'how much did we make from burgers'],
  ['STATIONS', 'which station made the most'],
  ['TRENDS', 'are we improving?'],
  ['TRENDS', 'this week vs last week'],
  ['WHY', 'why is profit down?'],
  ['STAFF', 'how much did we pay staff this month'],
  ['STAFF', 'who is the best waiter'],
  ['STAFF', 'which waiter sold the most'],
  ['FORECAST', 'how much will we make next month'],
  ['FORECAST', 'should i buy more chicken'],
  ['ADVICE', 'how can i increase profit'],
  ['ADVICE', 'what should i focus on'],
  ['RECORD', 'record an expense of 50000 for fuel'],
  ['RECORD', 'we paid our employee 250,000'],
]

describe('Jesse — a conversation from hello to the finances', () => {
  it('shows what it understands and what it silently guesses', () => {
    const rows = CONVO.map(([topic, q]) => {
      const intents = parseIntents(q)
      // An unmatched question is not refused — it is answered with revenue.
      const guessed = intents.length === 1 && intents[0] === 'revenue' && !/revenue|sales|income|made|make|earned|turnover|took in/i.test(q)
      return { topic, q, intents, guessed }
    })
    const pad = (s: string, n: number) => s.padEnd(n)
    console.log('\n' + pad('TOPIC', 11) + pad('QUESTION', 46) + 'JESSE HEARS')
    console.log('-'.repeat(104))
    for (const r of rows) {
      console.log(pad(r.topic, 11) + pad(r.q.slice(0, 44), 46) + (r.guessed ? '*** GUESSES revenue ***' : r.intents.join(', ')))
    }
    const bad = rows.filter(r => r.guessed)
    console.log('-'.repeat(104))
    console.log(`${bad.length} of ${rows.length} questions are misunderstood and answered with revenue figures:`)
    for (const b of bad) console.log(`   "${b.q}"`)
  })
})

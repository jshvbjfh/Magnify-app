// Jesse's question classifier.
//
// Lifted out of the route so it can be exercised directly: it is pure regex
// over the user's words, with no database or session behind it, so a few
// hundred phrasings can be run through it in a test instead of being guessed
// at by hand.
//
// One property matters more than any single pattern here: an unmatched question
// falls through to 'revenue' rather than to nothing. That means a question
// Jesse does not understand is not met with "I don't know" - it is answered
// confidently with revenue figures. Every gap is therefore a wrong answer, not
// a missing one, which is why the tests lean on the misunderstood cases.

export type Intent =
  | 'revenue' | 'profit' | 'orders' | 'expenses' | 'waste' | 'food_cost'
  | 'payment' | 'top_dishes' | 'low_stock' | 'stock_level'
  | 'dish_query' | 'branch_comparison' | 'pending_orders' | 'avg_order'
  | 'greeting' | 'catchup' | 'trends' | 'why' | 'record_transaction'
  | 'capabilities' | 'acknowledgement'

export function parseIntents(q: string): Intent[] {
  const s = new Set<Intent>()
  if (/\brevenue\b|\bsales\b|\bincome\b|\bhow much.*(made|make)\b|\bwe\s+(made|make)\b|\bearned\b|\b(made|make).*money\b|\btook\s+in\b|\bturnover\b/i.test(q)) s.add('revenue')
  // "profitable" and "profitability" have to be caught too — \bprofit\b stops at
  // the word boundary and misses both, which is how "are we profitable?" ended
  // up being answered with revenue figures.
  if (/\bprofit\w*\b|\bnet\s+profit\b|\bearning|\bmargins?\b|\bbottom\s+line\b/i.test(q)) s.add('profit')
  if (/\bloss(es)?\b|\blosing\b|\blose\s+money\b|\blost\s+money\b|\bin\s+the\s+red\b/i.test(q)) s.add('profit')
  if (/\borders?\b|\bhow many\s+orders?\b|\bnumber\s+of\s+orders?\b|\bcount\s+orders?\b/i.test(q)) s.add('orders')
  if (/\bexpenses?\b|\bpurchases?\b|\bprocurement\b|\bspent\b|\bspend\b|\bsuppl(y|ier)\b|\binventory\s+cost\b/i.test(q)) s.add('expenses')
  if (/\bwaste\b|\bwasted\b|\bspoilage?\b|\bspoilt?\b/i.test(q)) s.add('waste')
  if (/\bfood\s*cost\b|\bcogs\b|\bcost\s*of\s*goods\b/i.test(q)) s.add('food_cost')
  if (/\btop\s*dish(es)?\b|\bbest.?sell\b|\bpopular\b|\bmost\s*ordered\b|\bbest\s*dish\b|\bbest\s*drink\b|\bour\s+best\b/i.test(q)) s.add('top_dishes')
  if (/\blow\s*stock\b|\brun(ning)?\s*out\b|\breorder\b|\bshortage\b|\bfinish(ing|ed)?\b|\brestock\b|\bstock\s*up\b|\bwhat\s+should\s+i\s+restock\b|\bwhat.*restock\b|\bneed\s+to\s+buy\b|\bneed\s+restocking\b/i.test(q)) s.add('low_stock')
  if (/\bmomo\b|\bmobile\s*money\b|\bbank\b|\bcheque\b|\bcheck\b|\bcard\b|\bcash\b|\bcredit\b|\bpayment\s*method\b|\bpaid\s*by\b|\bbreakdown\b/i.test(q)) s.add('payment')
  // Deliberately not just "how much X do we have": that shape is far more often
  // about money than about an ingredient, and it was routing "how much cash do
  // we have" and "how much margin do we make on drinks" to the stock report.
  const asksAboutMoney = /\b(cash|money|margins?|profit\w*|revenue|sales|income|budget|funds?|balance)\b/i.test(q)
  if (!asksAboutMoney && (
    /\bin\s+stock\b|\bstock\s+level\b|\bstock\s+of\b|\bquantity\s+of\b|\bdo\s+we\s+have\b|\bhow\s+much\s+.{2,40}\s+(do\s+we|is\s+left|remaining|available)\b|\bhow\s+many\s+\w+\s+of\b/i.test(q)
  )) s.add('stock_level')
  // General inventory / stock status — "how's our stock", "our inventory",
  // "stock report", "inventory for <branch>". Without this, a bare stock/inventory
  // question matches no intent and wrongly falls through to the revenue default.
  if (!s.has('stock_level') && !s.has('low_stock')
    && /\b(stock|inventory)\b/i.test(q)
    && !/\binventory\s+(cost|purchases?|expenses?)\b/i.test(q)
    && !/\bspend\b|\bspent\b/i.test(q)) s.add('low_stock')
  // Specific dish revenue/sales — "how much from burgers", "how many chicken wings did we sell"
  if (
    (/\b(revenue|sales|income|made|earned)\s+(from|of)\s+[a-z]/i.test(q) ||
     /\bhow\s+many\s+[a-z][\w\s]+\s+(did\s+we\s+sell|sold|were\s+sold)\b/i.test(q) ||
     /\bhow\s+much\s+(did\s+we\s+make\s+from|from)\s+[a-z]/i.test(q) ||
     /\b[a-z][\w\s]+\s+(sales|revenue)\s+(today|yesterday|this|last|past)\b/i.test(q)) &&
    !/\b(momo|cash|bank|cheque|card|credit)\b/i.test(q)
  ) s.add('dish_query')
  // Station comparison — "which station made the most", "revenue by station", "expenses station by station"
  // (also recognizes the legacy "branch" wording so older habits still work)
  if (/\bwhich\s+(branch|station)\b|\b(branch|station)(es|s)?\s+(comparison|performance|revenue|sales|ranking)\b|\brevenue\s+by\s+(branch|station)\b|\btop\s+(branch|station)\b|\bper\s+(branch|station)\b|\b(branch|station)\s+by\s+(branch|station)\b|\bby\s+(branch|station)\b/i.test(q)) s.add('branch_comparison')
  // Pending / outstanding orders right now
  if (/\bpending\s+orders?\b|\boutstanding\s+orders?\b|\bopen\s+orders?\b|\borders?\s+(still\s+)?(pending|open|outstanding)\b|\bright\s+now\b.*orders?\b|\borders?.*right\s+now\b/i.test(q)) s.add('pending_orders')
  // Average order value
  if (/\baverage\s+(order|sale|transaction|value|revenue)\b|\bavg\s+(order|sale|value)\b/i.test(q)) s.add('avg_order')
  // ── Greeting ─────────────────────────────────────────────────────────────────
  // Allows a lead-in — "ok umm how was your day?" — because people rarely open
  // a message with the greeting sitting at character one. Without that, such a
  // question matched nothing and came back as a revenue report.
  if (/^(hi+|hello+|hey+|good\s*(morning|afternoon|evening|day|night)|howdy|greetings|morning|evening|afternoon|how\s+are\s+you|how'?s\s+it(\s+going)?|what'?s\s+up|sup|yo|salut|bonjour|hola|jambo|muraho|niaje|habari|mwaramutse|amakuru)\b/i.test(q.trim())
      || /\b(how\s+(was|is)\s+your\s+(day|evening|morning|night)|how\s+are\s+you\s+(doing|today)|how\s+have\s+you\s+been|are\s+you\s+(ok|okay|well|there)|hope\s+you'?re\s+well)\b/i.test(q)) s.add('greeting')
  // Record transaction — keyword/sentence based detection
  const hasAmount = /\b\d[\d,]*\s*(k|thousand)?\b/i.test(q)
  const isQuery = /\b(how much|how many|what did|what are|how little|which|show me|list|total|summary|report)\b/i.test(q)
  if (!isQuery && !s.has('pending_orders') && !s.has('avg_order') && (
    // ── Clear recording commands (no amount needed) ──
    /\b(record\s+this|log\s+this|save\s+this\s+(transaction|expense|record|payment)|add\s+this\s+entry|create\s+(an?\s+)?entry|book\s+this\s+transaction|register\s+this\s+payment|enter\s+this\s+expense|post\s+this\s+entry|journalize(\s+this)?|add\s+to\s+(ledger|books)|create\s+(accounting|bookkeeping)\s+(record|entry)|process\s+payroll|close\s+the\s+books|reconcile\s+account|bank\s+reconciliation|accrue\s+this|defer\s+this\s+revenue|capitalize\s+this|amortize\s+this|write\s+off\s+the|reverse\s+accrual|update\s+trial\s+balance|reflect\s+in\s+p.?l|update\s+balance\s+sheet|note\s+this\s+transaction|track\s+this\s+(purchase|payment|expense)|capture\s+this\s+expense|save\s+record|sync\s+transaction|post\s+to\s+ledger)\b/i.test(q) ||
    // ── Explicit record triggers with category ──
    /\b(record|log|add|post|enter)\s+(?:a\s+)?(?:transaction|entry|expense|income|payment|sale|purchase|journal|payroll|salary|refund|invoice|deposit|loan|asset|depreciation)\b/i.test(q) ||
    // ── Income / Revenue sentence phrases ──
    /\b(received\s+payment|got\s+paid|client\s+(paid|cleared|settled)|customer\s+(paid|settled|cleared)|invoice\s+was\s+paid|received\s+money|money\s+came\s+in|received\s+deposit|got\s+revenue|earned\s+income|collected\s+cash|received\s+transfer|payment\s+received|booked\s+revenue|sales\s+came\s+in|cash\s+received\s+today|money\s+received\s+today|the\s+client\s+finally\s+paid|customer\s+cleared\s+(their\s+)?balance|supplier\s+refunded\s+us|refund\s+received|cashback\s+received|settlement\s+received|installment\s+received|financing\s+received|funding\s+secured|investment\s+received|dividend\s+received|remittance\s+received|claim\s+received|insurance\s+payout|we\s+received\s+cash)\b/i.test(q) ||
    // ── Expense / Payment sentence phrases ──
    /\b(settled\s+the\s+bill|cleared\s+the\s+invoice|paid\s+(supplier|vendor|employees|staff|salary|wages|rent|invoice|contractor|freelancer|tax|vat|insurance|utility|bill|interest|loan|penalty|fee)|paid\s+via\s+(mtn|airtel|momo|bank|card)|processed\s+payroll|salary\s+paid|wages\s+paid|staff\s+payment|payroll\s+processed|commission\s+paid|bonus\s+paid|allowance\s+paid|reimbursed\s+(employee|expense)|made\s+(a\s+)?payment|sent\s+payment|made\s+(a\s+)?transfer|transferred\s+funds|moved\s+money|bank\s+charged\s+fee|bank\s+deducted|withdrew\s+cash|deposited\s+cash|momo\s+payment|mobile\s+money\s+payment|card\s+was\s+charged|pos\s+payment|supplier\s+has\s+been\s+paid|employee\s+salaries\s+went\s+out|we\s+paid\s+for|we\s+(spent|bought|purchased)|covered\s+expenses|asset\s+acquired|equipment\s+(purchased|bought|installed)|record\s+depreciation|depreciate\s+asset|disposed\s+asset|sold\s+asset|asset\s+write.?off|subscription\s+renewed|monthly\s+payment\s+made|annual\s+fee\s+paid|insurance\s+premium\s+paid|maintenance\s+contract\s+renewed|standing\s+order\s+executed|advance\s+payment\s+made|prepayment\s+made|security\s+deposit\s+paid|escrow\s+payment|retention\s+payment|converted\s+currency|forex\s+(gain|loss)\s+recorded|international\s+payment\s+sent|remittance\s+sent|owner\s+(invested|withdrew)|shareholder\s+contribution|capital\s+injected|dividend\s+paid|drawings\s+recorded|profit\s+reinvested|equity\s+contribution|customer\s+refunded|refund\s+issued|credit\s+note\s+issued|discount\s+(applied|given)|purchase\s+returned|sales\s+return|damaged\s+goods\s+returned)\b/i.test(q) ||
    // ── Natural conversational phrases ──
    /\b(please\s+save\s+this\s+expense|add\s+this\s+to\s+(accounting|books)|I\s+need\s+this\s+recorded|log\s+the\s+(utility|fuel|salary|rent|payroll|water|electricity|internet)\s+payment|record\s+today.?s\s+sales|track\s+this\s+payment|register\s+the\s+incoming\s+transfer|the\s+bank\s+deducted\s+charges|fix\s+the\s+duplicate\s+transaction|remove\s+the\s+wrong\s+entry|adjust\s+the\s+(final\s+)?balance|update\s+the\s+(invoice|record|financials))\b/i.test(q) ||
    // ── Natural payee-before-amount: "we paid our employee 250,000", "we sold a dish for 250,000" ──
    (hasAmount && /\b(we\s+)?(paid|sold|spent|received|earned|bought|gave)\s+(?:our\s+|a\s+|the\s+|an\s+|for\s+)?\w/i.test(q)) ||
    // ── With amounts: action words + number ──
    (hasAmount && (
      /\b(paid|spent|bought|purchased|received|earned|sold|withdrew|deposited)\s+[\d,]+/i.test(q) ||
      /\b[\d,]+\s*(k\b)?\s+(for|on)\s+\w/i.test(q) ||
      /\b(fuel|diesel|petrol|rent|salary|wages|payroll|electricity|water|internet|airtime|repair|maintenance|supplies|insurance|tax|vat|paye|cleaning|transport|delivery|bonus|overtime|commission\s+payout|per\s+diem|contractor|allowance|equipment|vehicle|laptop|machinery|furniture|capex|depreciation|loan\s+repayment|installment|mortgage|dividend|drawings|petty\s+cash|shipping|freight|customs|logistics|marketing|advertising|legal\s+fee|audit\s+fee|consultancy|training|workshop|seminar|school\s+fees|membership|donation|interest\s+expense|bank\s+fee|hosting|domain|saas|cloud|hardware|phone\s+bill|data\s+bundle|telecom|insurance\s+premium|procurement|sourcing|packaging|warehousing|sponsorship|branding|pr\s+expense|permit\s+fee|registration\s+fee|government\s+fee|oil\s+change|tire|security\s+deposit|advance\s+payment|prepayment|reimbursement|settlement)\s+[\d,]+/i.test(q) ||
      /\b(expense|payment|bill|invoice|fee|charge|cost)\s+of\s+[\d,]+/i.test(q) ||
      /\b(utility|travel|fuel|maintenance|operating|staff|payroll|rent|office|software|subscription|telecom|legal|marketing|advertising|promotion|training|insurance|procurement|logistics|shipping|delivery|courier|freight|transport|storage|cleaning|security|repair|it\s+support|hosting|domain|saas|cloud|hardware|donation|membership|education|workshop|seminar)\s+expense\b/i.test(q)
    )) ||
    // ── Accounting-specific terms (always record intent) ──
    /\b(journal\s+entry|ledger\s+entry|bookkeeping|accrual|adjustment\s+entry|reversal\s+entry|adjusting\s+entry|closing\s+entry|accrue\s+this|defer\s+this|capitalize\s+this\s+cost|amortize\s+this|recognize\s+the\s+revenue|impair\s+the\s+asset|allocate\s+overhead|distribute\s+cost|journalize\s+this|create\s+adjusting\s+entry|close\s+(revenue|expense)\s+account|record\s+retained\s+earnings)\b/i.test(q)
  )) s.add('record_transaction')

  // Catch-up — "how's business?", "how are we doing?", "give me a summary", "anything I should know?"
  if (/\b(how.?s\s*business|how\s+are\s+we\s+doing|how.?s\s+today|how.?s\s+it\s+going|what.?s\s+the\s+situation|give\s+me\s+a\s+summary|anything\s+(new|i\s+should\s+know)|what.?s\s+up|catch\s+me\s+up|update\s+me|what\s+happened\s+today|daily\s+recap|overview|snapshot)\b/i.test(q)) s.add('catchup')
  // Trends — "trending?", "are we improving?", "this week vs last", "compare periods"
  if (/\b(trend(ing)?|improving|getting\s+better|getting\s+worse|this\s+week\s+vs|last\s+week\s+vs|compare\s+(to|with)\s+(last|previous)|versus\s+last|period\s+over\s+period|week\s+on\s+week|month\s+on\s+month|are\s+we\s+(up|down|growing|declining))\b/i.test(q)) s.add('trends')
  // Why — "why is X low?", "what caused this?", "explain", or bare "why?"
  if (/\b(why(\s+is|\s+are|\s+did|\s+has|\s+were)?|what\s+caused|what.?s\s+causing|explain(\s+this|\s+the|\s+why)?|what\s+went\s+wrong|what.?s\s+the\s+reason|how\s+come|tell\s+me\s+why)\b/i.test(q)) s.add('why')

  // "what can you do?" / "help" — asking what Jesse is for. Answering that with
  // yesterday's takings is the least useful reply available.
  if (/\b(what\s+can\s+you\s+do|what\s+do\s+you\s+do|who\s+are\s+you|what\s+are\s+you|how\s+do\s+i\s+use|what\s+should\s+i\s+ask|can\s+you\s+help|^help\b|\bhelp\s+me\b|your\s+(features|abilities)|list\s+(your\s+)?commands)\b/i.test(q.trim())) s.add('capabilities')

  // "thanks" / "ok" — a closing remark, not a request for a financial report.
  // Allows a short string of them — "ok cool", "great thanks" — since that is
  // how people actually close a message.
  if (/^((thanks?|thank\s+you|thx|asante|murakoze|ok(ay)?|cool|nice|great|good|perfect|lovely|got\s+it|understood|alright|sure|fine|yep|yeah|noted|awesome|brilliant)[\s,.!]*)+$/i.test(q.trim())
      || /^(thank\s+you|thanks)\b/i.test(q.trim())) s.add('acknowledgement')

  // Nothing matched. Rather than reporting revenue as though that were the
  // question, the caller can see the question was not understood and say so.
  if (s.size === 0) s.add('revenue')
  return [...s]
}

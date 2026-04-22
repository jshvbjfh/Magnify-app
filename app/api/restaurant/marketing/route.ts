import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { clearGeminiQuotaFailure, getGeminiAttemptPlan, getGeminiApiKeys, getGeminiKeyAvailability, getGeminiRetryConfig, getGeminiUnavailableMessage, isQuotaError, isRetryableGeminiServiceError, markGeminiQuotaFailure } from '@/lib/openai'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

export const dynamic = 'force-dynamic'

function delay(ms: number) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildCampaignScopeMarker(billingUserId: string, restaurantId: string | null, branchId: string | null) {
  return branchId
    ? `"branchId":"${branchId}"`
    : restaurantId
    ? `"restaurantId":"${restaurantId}"`
    : `"billingUserId":"${billingUserId}"`
}

function parseCampaignRecord(data: string, billingUserId: string, restaurantId: string | null, branchId: string | null) {
  try {
    const parsed = JSON.parse(data)
    if (branchId) {
      return parsed?.branchId === branchId ? parsed : null
    }
    if (restaurantId) {
      return parsed?.restaurantId === restaurantId ? parsed : null
    }
    return parsed?.billingUserId === billingUserId ? parsed : null
  } catch {
    return null
  }
}

function sanitize(text: string): string {
  return text
    .replace(/\bGemini\b/gi, 'Magnify')
    .replace(/\bGoogle\s*AI\b/gi, 'Magnify')
    .replace(/\bGoogle\s+Generative\s+AI\b/gi, 'Magnify')
    .replace(/\bgemini-[a-z0-9.-]+\b/gi, 'Magnify model')
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const action = searchParams.get('action') // 'diagnose' | 'campaigns'

  const userId = session.user.id
  const restaurantCtx = await getRestaurantContextForUser(userId)
  const billingUserId = restaurantCtx?.billingUserId ?? userId
  const restaurantId = restaurantCtx?.restaurantId ?? null
  const branchId = restaurantCtx?.branchId ?? null
  const campaignScopeMarker = buildCampaignScopeMarker(billingUserId, restaurantId, branchId)
  const now = new Date()

  // ── Revenue trend: last 8 weeks ─────────────────────────────────────────
  const weeksAgo8 = new Date(now)
  weeksAgo8.setDate(weeksAgo8.getDate() - 56)

  const sales = await prisma.dishSale.findMany({
    where: { userId: billingUserId, ...(restaurantId ? { restaurantId } : {}), ...(branchId ? { branchId } : {}), saleDate: { gte: weeksAgo8 } },
    include: { dish: true },
    orderBy: { saleDate: 'asc' },
  })

  // Build weekly buckets
  const weeklyRevenue: Record<string, number> = {}
  for (const s of sales) {
    const d = new Date(s.saleDate)
    const weekStart = new Date(d)
    weekStart.setDate(d.getDate() - d.getDay())
    const key = weekStart.toISOString().split('T')[0]
    weeklyRevenue[key] = (weeklyRevenue[key] ?? 0) + s.totalSaleAmount
  }
  const weeklyTrend = Object.entries(weeklyRevenue)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, revenue]) => ({ week, revenue }))

  // ── Day-of-week breakdown ─────────────────────────────────────────────
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const dayRevenue: Record<number, number> = {}
  for (let i = 0; i < 7; i++) dayRevenue[i] = 0
  for (const s of sales) {
    dayRevenue[new Date(s.saleDate).getDay()] += s.totalSaleAmount
  }
  const dayTrend = dayNames.map((day, i) => ({ day, revenue: dayRevenue[i] }))

  // ── Hourly breakdown (last 30 days) ──────────────────────────────────
  const thirtyAgo = new Date(now)
  thirtyAgo.setDate(thirtyAgo.getDate() - 30)
  const recentSales = sales.filter(s => new Date(s.saleDate) >= thirtyAgo)

  const hourRevenue: Record<number, number> = {}
  for (let h = 0; h < 24; h++) hourRevenue[h] = 0
  for (const s of recentSales) {
    hourRevenue[new Date(s.saleDate).getHours()] += s.totalSaleAmount
  }
  const hourTrend = Object.entries(hourRevenue).map(([h, revenue]) => ({
    hour: `${h.padStart ? h : String(h).padStart(2, '0')}:00`,
    revenue,
  }))

  // ── Top & Bottom dishes ───────────────────────────────────────────────
  const dishMap: Record<string, { name: string; revenue: number; orders: number; category: string }> = {}
  for (const s of recentSales) {
    if (!dishMap[s.dishId]) dishMap[s.dishId] = { name: s.dish.name, revenue: 0, orders: 0, category: s.dish.category ?? 'Uncategorized' }
    dishMap[s.dishId].revenue += s.totalSaleAmount
    dishMap[s.dishId].orders += s.quantitySold
  }
  const allDishStats = Object.values(dishMap).sort((a, b) => b.revenue - a.revenue)
  const topDishes = allDishStats.slice(0, 5)
  const bottomDishes = allDishStats.slice(-3).reverse()

  // ── Campaign history (stored in FinancialStatement table as type 'marketing_campaign') ──
  const campaignHistory = await prisma.financialStatement.findMany({
    where: { type: 'marketing_campaign', data: { contains: campaignScopeMarker } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  const campaigns = campaignHistory
    .map((c) => parseCampaignRecord(c.data, billingUserId, restaurantId, branchId))
    .filter(Boolean)

  // ── Total revenue last 30d vs prev 30d ───────────────────────────────
  const prev30start = new Date(thirtyAgo)
  prev30start.setDate(prev30start.getDate() - 30)
  const prev30sales = await prisma.dishSale.findMany({
    where: { userId: billingUserId, ...(restaurantId ? { restaurantId } : {}), ...(branchId ? { branchId } : {}), saleDate: { gte: prev30start, lt: thirtyAgo } },
    select: { totalSaleAmount: true },
  })
  const rev30 = recentSales.reduce((s, x) => s + x.totalSaleAmount, 0)
  const prevRev30 = prev30sales.reduce((s, x) => s + x.totalSaleAmount, 0)
  const revTrendPct = prevRev30 > 0 ? ((rev30 - prevRev30) / prevRev30) * 100 : null

  return NextResponse.json({
    weeklyTrend,
    dayTrend,
    hourTrend,
    topDishes,
    bottomDishes,
    allDishStats,
    rev30,
    prevRev30,
    revTrendPct: revTrendPct !== null ? Number(revTrendPct.toFixed(1)) : null,
    campaigns,
    salesCount30d: recentSales.length,
  })
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const restaurantCtx = await getRestaurantContextForUser(session.user.id)
  const billingUserId = restaurantCtx?.billingUserId ?? session.user.id
  const restaurantId = restaurantCtx?.restaurantId ?? null
  const branchId = restaurantCtx?.branchId ?? null
  const body = await req.json()
  const { action, context, campaignData } = body

  // ── Save campaign result ──────────────────────────────────────────────
  if (action === 'save_campaign') {
    if (!campaignData || typeof campaignData !== 'object') {
      return NextResponse.json({ error: 'campaignData required' }, { status: 400 })
    }
    const record = await prisma.financialStatement.create({
      data: {
        type: 'marketing_campaign',
        periodStart: new Date(),
        periodEnd: new Date(),
        data: JSON.stringify({
          ...campaignData,
          currentUserId: session.user.id,
          billingUserId,
          restaurantId,
          branchId,
          savedAt: new Date().toISOString(),
        }),
      },
    })
    return NextResponse.json({ ok: true, id: record.id })
  }

  // ── AI: diagnose or generate campaign ────────────────────────────────
  if (action !== 'diagnose' && action !== 'generate_campaign' && action !== 'generate_content') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  const apiKeys = getGeminiApiKeys()
  if (apiKeys.length === 0) return NextResponse.json({ error: 'AI service not configured' }, { status: 500 })
  const keyAvailability = getGeminiKeyAvailability(apiKeys)
  if (keyAvailability.availableKeyCount === 0) {
    return NextResponse.json({ error: getGeminiUnavailableMessage('Jesse AI') }, { status: 429 })
  }

  let prompt = ''

  if (action === 'diagnose') {
    const { weeklyTrend, dayTrend, topDishes, bottomDishes, rev30, prevRev30, revTrendPct, salesCount30d } = context

    prompt = `You are Jesse, a world-class restaurant marketing strategist. Analyze this restaurant's real performance data and produce a marketing diagnosis.

PERFORMANCE DATA:
- Revenue last 30 days: ${rev30?.toLocaleString() ?? 0}
- Revenue previous 30 days: ${prevRev30?.toLocaleString() ?? 0}
- Revenue trend: ${revTrendPct !== null ? `${revTrendPct > 0 ? '+' : ''}${revTrendPct}%` : 'N/A'}
- Orders last 30 days: ${salesCount30d ?? 0}
- Weekly revenue trend (earliest→latest): ${weeklyTrend?.map((w: any) => `${w.week}: ${w.revenue?.toLocaleString()}`).join(', ') ?? 'No data'}
- Best days: ${dayTrend?.sort((a: any, b: any) => b.revenue - a.revenue).slice(0, 3).map((d: any) => `${d.day}: ${d.revenue?.toLocaleString()}`).join(', ') ?? 'N/A'}
- Slowest days: ${dayTrend?.sort((a: any, b: any) => a.revenue - b.revenue).slice(0, 2).map((d: any) => `${d.day}: ${d.revenue?.toLocaleString()}`).join(', ') ?? 'N/A'}
- Top dishes: ${topDishes?.map((d: any) => `${d.name} (${d.orders} orders, ${d.revenue?.toLocaleString()} revenue)`).join(', ') ?? 'N/A'}
- Slow dishes: ${bottomDishes?.map((d: any) => `${d.name} (${d.orders} orders)`).join(', ') ?? 'N/A'}

TASK: Diagnose the marketing problem and output a JSON object. Use ONLY this exact format:

{
  "problemCategory": "Awareness | Excitement | Value | Experience | Competition | Growth",
  "problemTitle": "Short 3-6 word title",
  "problemSummary": "2-3 sentence plain English explanation of what the data shows",
  "keyObservations": ["observation 1", "observation 2", "observation 3"],
  "urgency": "low | medium | high",
  "recommendedGoal": "Bring new customers | Re-engage old customers | Increase visit frequency | Increase order value | Promote a dish | Boost slow days",
  "topOpportunity": "One specific actionable insight (1 sentence)",
  "magicQuestion": "One question starting with 'Why should someone come...' or similar that frames the opportunity"
}

Return ONLY the JSON. No explanation, no markdown fences.`
  }

  if (action === 'generate_campaign') {
    const { diagnosis, campaignType, restaurantName } = context

    const campaignLibrary: Record<string, any> = {
      comeback: {
        name: 'Come Back Campaign',
        goal: 'Re-engage customers who haven\'t visited recently',
        tactics: ['SMS/message discount for previous customers', 'Loyalty reward offer', '"We miss you" limited special'],
      },
      buzz: {
        name: 'Buzz Campaign',
        goal: 'Create excitement and word-of-mouth',
        tactics: ['New dish launch event', 'Chef Special Week', 'Behind-the-scenes tasting event'],
      },
      value: {
        name: 'Value Campaign',
        goal: 'Attract price-sensitive customers and boost volume',
        tactics: ['Combo meal deals', 'Lunch specials at reduced price', 'Family packages'],
      },
      experience: {
        name: 'Experience Campaign',
        goal: 'Improve atmosphere and create reasons to visit',
        tactics: ['Live music night', 'Themed dining night', 'Trivia night', 'Sports viewing night'],
      },
      viral: {
        name: 'Viral Social Campaign',
        goal: 'Generate online attention and new customers',
        tactics: ['Food challenge with reward', 'Instagram photo wall', 'TikTok dish/challenge'],
      },
      slowday: {
        name: 'Slow Day Booster',
        goal: 'Turn the slowest days into strong trading days',
        tactics: ['Special offer only on slow days', 'Event tied to that day of week', '"Taco Tuesday" style naming'],
      },
    }

    const campaign = campaignLibrary[campaignType] ?? campaignLibrary.buzz

    prompt = `You are Jesse, a world-class restaurant marketing strategist. Generate a complete, detailed marketing campaign plan for this restaurant.

RESTAURANT: ${restaurantName ?? 'This Restaurant'}

DIAGNOSIS:
- Problem: ${diagnosis?.problemTitle ?? 'Unknown'}
- Category: ${diagnosis?.problemCategory ?? 'Excitement'}
- Summary: ${diagnosis?.problemSummary ?? ''}
- Key observations: ${diagnosis?.keyObservations?.join('; ') ?? ''}
- Goal: ${diagnosis?.recommendedGoal ?? 'Boost traffic'}
- Top opportunity: ${diagnosis?.topOpportunity ?? ''}

CAMPAIGN TYPE: ${campaign.name}
Campaign goal: ${campaign.goal}
Available tactics: ${campaign.tactics.join(', ')}

Generate a complete, specific campaign plan in JSON. Use this EXACT format:

{
  "campaignName": "Creative, catchy campaign name",
  "campaignType": "${campaignType}",
  "tagline": "A short punchy tagline for the campaign",
  "goal": "One clear sentence goal",
  "strategy": "2-3 sentences describing the core strategy and why it will work for this specific restaurant",
  "duration": "e.g. '2 weeks' or 'Every Friday for a month'",
  "promotionPlan": [
    { "channel": "Instagram", "action": "Specific post idea with exact content direction" },
    { "channel": "In-store", "action": "Specific in-store promotion idea" },
    { "channel": "WhatsApp/SMS", "action": "Specific message idea" }
  ],
  "specificOffer": "The exact offer or hook (e.g. '30% off on Mondays for lunch', 'Spicy wing challenge — finish in 5 min, eat free')",
  "bestDay": "Best day/time to launch and why",
  "expectedImpact": "Realistic expected result (e.g. '+15-25% weekend covers')",
  "successMetric": "How to know it worked (one measurable thing)",
  "lowCostTip": "One tip to run this campaign with minimal budget",
  "instagramCaption": "A ready-to-use Instagram caption for this campaign (include relevant hashtags)",
  "smsTemplate": "A ready-to-send SMS/WhatsApp message template (under 160 chars)",
  "weeklyReasons": ["3 specific 'reason to visit' ideas this restaurant can use ongoing"]
}

Make every field SPECIFIC to this restaurant's situation. Reference their actual data. Return ONLY the JSON.`
  }

  if (action === 'generate_content') {
    const { campaign, contentType, restaurantName } = context
    const typeMap: Record<string, string> = {
      instagram: 'an Instagram post caption with 5-8 relevant hashtags',
      sms: 'an SMS/WhatsApp message under 160 characters',
      email: 'a promotional email subject line and body (under 150 words)',
      poster: 'poster headline text and 3-5 bullet points for an in-store printed poster',
    }
    const desc = typeMap[contentType] ?? 'marketing copy'

    prompt = `You are Jesse, an expert restaurant marketing copywriter.

RESTAURANT: ${restaurantName ?? 'This Restaurant'}
CAMPAIGN: ${campaign?.campaignName ?? 'Promotion'}
TAGLINE: ${campaign?.tagline ?? ''}
OFFER: ${campaign?.specificOffer ?? ''}
STRATEGY: ${campaign?.strategy ?? ''}

Write ${desc} for this campaign. Be creative, specific, and compelling. 
Return ONLY the content text — no JSON, no explanation, no extra formatting. Just the copy itself.`
  }

  const retryConfig = getGeminiRetryConfig()
  const exhaustedKeyIndexes = new Set<number>()
  const keyOnlyQuotaFailures = new Map<number, boolean>(apiKeys.map((_, index) => [index, true]))
  let lastError: any = null

  for (const attempt of getGeminiAttemptPlan(apiKeys)) {
    if (exhaustedKeyIndexes.has(attempt.keyIndex)) continue

    const genAI = new GoogleGenerativeAI(attempt.apiKey)
    let serviceUnavailableRetryCount = 0

    while (true) {
      try {
        const model = genAI.getGenerativeModel({ model: attempt.modelName })
        const result = await model.generateContent(prompt)
        let text = result.response.text().trim()
        clearGeminiQuotaFailure(attempt.apiKey)
        text = sanitize(text)

        if (action === 'diagnose' || action === 'generate_campaign') {
          // Strip markdown fences if any
          text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
          try {
            const parsed = JSON.parse(text)
            return NextResponse.json({ ok: true, result: parsed })
          } catch {
            // Try to extract JSON
            const match = text.match(/\{[\s\S]+\}/)
            if (match) {
              try {
                const parsed = JSON.parse(match[0])
                return NextResponse.json({ ok: true, result: parsed })
              } catch { /* fall through */ }
            }
            return NextResponse.json({ ok: true, result: text })
          }
        }

        return NextResponse.json({ ok: true, result: text })
      } catch (e: any) {
        lastError = e
        if (isQuotaError(e)) {
          markGeminiQuotaFailure(attempt.apiKey, e)
          exhaustedKeyIndexes.add(attempt.keyIndex)
          break
        }
        keyOnlyQuotaFailures.set(attempt.keyIndex, false)
        if (isRetryableGeminiServiceError(e) && serviceUnavailableRetryCount < retryConfig.serviceUnavailableRetries) {
          serviceUnavailableRetryCount++
          await delay(retryConfig.serviceUnavailableDelayMs)
          continue
        }
        break
      }
    }
  }

  const allKeysQuotaExhausted =
    keyAvailability.blockedKeyCount + exhaustedKeyIndexes.size === apiKeys.length &&
    apiKeys.every((_, index) => keyOnlyQuotaFailures.get(index) === true)

  if (allKeysQuotaExhausted) {
    return NextResponse.json({ error: getGeminiUnavailableMessage('Jesse AI') }, { status: 429 })
  }

  if (lastError) {
    console.error('[Marketing API]', lastError)
    if (!isRetryableGeminiServiceError(lastError)) {
      return NextResponse.json({ error: lastError.message ?? 'AI error' }, { status: 500 })
    }
  }

  return NextResponse.json({ error: 'AI service unavailable' }, { status: 503 })
}

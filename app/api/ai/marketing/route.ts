import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { prisma } from '@/lib/prisma'
import { getGeminiCandidates, getGeminiApiKeys, isQuotaError } from '@/lib/openai'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function startOfWeek(offsetWeeks: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay() - offsetWeeks * 7)
  d.setHours(0, 0, 0, 0)
  return d
}

function endOfWeek(offsetWeeks: number): Date {
  const d = startOfWeek(offsetWeeks)
  d.setDate(d.getDate() + 6)
  d.setHours(23, 59, 59, 999)
  return d
}

function getWeekLabel(offsetWeeks: number): string {
  if (offsetWeeks === 0) return 'This Week'
  if (offsetWeeks === 1) return 'Last Week'
  return `${offsetWeeks} Weeks Ago`
}

function extractJsonFromText(text: string): any {
  // Try markdown code fence
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()) } catch { /* continue */ }
  }
  // Try raw JSON object
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch { /* continue */ }
  }
  return null
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const mode: 'analyze' | 'content' | 'chat' = body.mode ?? 'analyze'

    const apiKeys = getGeminiApiKeys()
    if (apiKeys.length === 0) {
      return NextResponse.json({ error: 'AI service not configured' }, { status: 500 })
    }

    // ── Gather restaurant data ───────────────────────────────────────────────

    const eightWeeksAgo = startOfWeek(8)

    const [allSales, allShifts, allWaste, allDishes] = await Promise.all([
      prisma.dishSale.findMany({
        where: { userId: session.user.id, saleDate: { gte: eightWeeksAgo } },
        include: { dish: true },
        orderBy: { saleDate: 'asc' },
      }),
      prisma.shift.findMany({
        where: { userId: session.user.id, date: { gte: eightWeeksAgo } },
      }),
      prisma.wasteLog.findMany({
        where: { userId: session.user.id, date: { gte: eightWeeksAgo } },
      }),
      prisma.dish.findMany({
        where: { userId: session.user.id, isActive: true },
        select: { id: true, name: true, sellingPrice: true, category: true },
      }),
    ])

    // ── Weekly revenue breakdown (0 = current week, 7 = oldest) ────────────
    const weeklyData: Array<{ label: string; revenue: number; orders: number }> = []
    for (let w = 7; w >= 0; w--) {
      const from = startOfWeek(w)
      const to = endOfWeek(w)
      const weekSales = allSales.filter(s => {
        const d = new Date(s.saleDate)
        return d >= from && d <= to
      })
      weeklyData.push({
        label: getWeekLabel(w),
        revenue: weekSales.reduce((sum, s) => sum + Number(s.totalSaleAmount), 0),
        orders: weekSales.length,
      })
    }

    // ── Trend detection ──────────────────────────────────────────────────────
    const thisWeekRev = weeklyData[7].revenue
    const lastWeekRev = weeklyData[6].revenue
    const twoWeeksAgoRev = weeklyData[5].revenue
    const revTrendPct =
      lastWeekRev > 0 ? ((thisWeekRev - lastWeekRev) / lastWeekRev) * 100 : 0
    const revTrend =
      revTrendPct > 5 ? 'growing' : revTrendPct < -5 ? 'declining' : 'flat'

    // ── Dish performance ─────────────────────────────────────────────────────
    const dishMap: Record<string, { name: string; revenue: number; orders: number; category: string }> = {}
    for (const sale of allSales) {
      const key = sale.dishId
      if (!dishMap[key]) {
        dishMap[key] = {
          name: sale.dish.name,
          revenue: 0,
          orders: 0,
          category: sale.dish.category ?? 'Uncategorized',
        }
      }
      dishMap[key].revenue += Number(sale.totalSaleAmount)
      dishMap[key].orders += Number(sale.quantitySold)
    }
    const dishStats = Object.values(dishMap).sort((a, b) => b.revenue - a.revenue)
    const topDishes = dishStats.slice(0, 5)
    const bottomDishes = dishStats.slice(-5).reverse()

    // Dishes with ZERO sales
    const soldDishIds = new Set(allSales.map(s => s.dishId))
    const unsoldDishes = allDishes.filter(d => !soldDishIds.has(d.id)).slice(0, 5)

    // ── Day-of-week performance ──────────────────────────────────────────────
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const dayMap: Record<number, { revenue: number; orders: number }> = {}
    for (let i = 0; i < 7; i++) dayMap[i] = { revenue: 0, orders: 0 }
    for (const sale of allSales) {
      const dow = new Date(sale.saleDate).getDay()
      dayMap[dow].revenue += Number(sale.totalSaleAmount)
      dayMap[dow].orders += Number(sale.quantitySold)
    }
    const dayPerformance = dayNames.map((name, i) => ({ day: name, ...dayMap[i] }))
      .sort((a, b) => b.revenue - a.revenue)

    // ── Cost percentages ─────────────────────────────────────────────────────
    const totalRevenue = allSales.reduce((s, x) => s + Number(x.totalSaleAmount), 0)
    const totalCogs = allSales.reduce((s, x) => s + Number(x.calculatedFoodCost), 0)
    const totalLabor = allShifts.reduce((s, x) => s + Number(x.calculatedWage), 0)
    const totalWaste = allWaste.reduce((s, x) => s + Number(x.calculatedCost), 0)
    const foodCostPct = totalRevenue > 0 ? (totalCogs / totalRevenue) * 100 : 0
    const laborPct = totalRevenue > 0 ? (totalLabor / totalRevenue) * 100 : 0
    const wastePct = totalRevenue > 0 ? (totalWaste / totalRevenue) * 100 : 0
    const primeCostPct = foodCostPct + laborPct

    // ── Build snapshot for AI ────────────────────────────────────────────────
    const snapshot = {
      weeklyRevenueTrend: weeklyData,
      trend: { direction: revTrend, changePercent: revTrendPct.toFixed(1) },
      thisWeekRevenue: thisWeekRev,
      lastWeekRevenue: lastWeekRev,
      twoWeeksAgoRevenue: twoWeeksAgoRev,
      totalRevenueLastMonth: totalRevenue,
      topDishes,
      bottomDishes,
      unsoldDishes: unsoldDishes.map(d => d.name),
      dayPerformance,
      bestDay: dayPerformance[0]?.day ?? 'Unknown',
      worstDay: dayPerformance[6]?.day ?? 'Unknown',
      foodCostPct: foodCostPct.toFixed(1),
      laborPct: laborPct.toFixed(1),
      wastePct: wastePct.toFixed(1),
      primeCostPct: primeCostPct.toFixed(1),
      totalActiveDishes: allDishes.length,
    }

    // ── Select mode ──────────────────────────────────────────────────────────

    let prompt = ''

    if (mode === 'analyze') {
      prompt = buildAnalysisPrompt(snapshot)
    } else if (mode === 'content') {
      const { campaign } = body
      prompt = buildContentPrompt(campaign, snapshot)
    } else if (mode === 'chat') {
      const { message, context } = body
      prompt = buildChatPrompt(message, context, snapshot)
    }

    // ── Call Gemini ──────────────────────────────────────────────────────────
    let responseText = ''
    let quotaExhaustedCount = 0
    for (const currentKey of apiKeys) {
      const genAI = new GoogleGenerativeAI(currentKey)
      const candidates = await getGeminiCandidates(currentKey)
      let keyHadQuota = false
      for (const modelName of candidates.slice(0, 3)) {
        try {
          const model = genAI.getGenerativeModel({ model: modelName })
          const result = await model.generateContent(prompt)
          responseText = result.response.text()
          if (responseText) break
        } catch (e: any) {
          if (isQuotaError(e)) { keyHadQuota = true; break }
          /* try next model */
        }
      }
      if (responseText) break
      if (keyHadQuota) quotaExhaustedCount++
      else break
    }

    if (!responseText) {
      if (quotaExhaustedCount === apiKeys.length) {
        return NextResponse.json({ error: 'Daily AI limit reached. Jesse AI resets automatically — try again tomorrow.' }, { status: 429 })
      }
      return NextResponse.json({ error: 'AI service unavailable' }, { status: 503 })
    }

    if (mode === 'analyze' || mode === 'content') {
      const parsed = extractJsonFromText(responseText)
      if (parsed) {
        return NextResponse.json({ plan: parsed, snapshot })
      }
      // Fallback: return raw text wrapped
      return NextResponse.json({ plan: null, raw: responseText, snapshot })
    }

    // chat mode
    return NextResponse.json({ response: responseText })
  } catch (err: any) {
    console.error('[Marketing API]', err)
    return NextResponse.json({ error: err.message ?? 'Internal error' }, { status: 500 })
  }
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

function buildAnalysisPrompt(snapshot: any): string {
  return `You are Jesse, an expert restaurant marketing strategist. Analyze this restaurant's performance data and create a complete, actionable marketing plan.

RESTAURANT DATA (last 8 weeks):
${JSON.stringify(snapshot, null, 2)}

YOUR TASK — Think like a top marketing strategist:

STEP 1: Diagnose the core problem by analyzing:
- Revenue trend (growing/flat/declining)
- Dish performance (which are winning, which are dead)
- Day patterns (best/worst days)
- Cost health (food cost %, labor %, waste %)

STEP 2: Classify the problem into ONE primary category:
A: Awareness Problem — people don't know about the restaurant
B: Excitement Problem — people know but it feels boring/repetitive (flat sales, slow dish variety)
C: Value Problem — possible pricing issue (high food cost %, declining orders)
D: Experience Problem — operational issues (high waste, labor %, inconsistent days)
E: Competition Problem — external pressure patterns (sudden drop, previously strong)

STEP 3: Define the marketing objective

STEP 4: Create 2-3 full campaign plans from these types:
- "Come Back" Campaign: SMS/loyalty for previous customers
- Buzz Campaign: New dish launch, chef special week, tasting event
- Value Campaign: Combo meals, lunch deals, family packages
- Experience Campaign: Live music, themed nights, trivia night
- Viral Social Campaign: Food challenge, Instagram wall, TikTok dish

STEP 5: Generate ready-to-use content for the TOP recommended campaign

RESPONSE FORMAT — Return ONLY this JSON (no text before or after):
{
  "diagnosis": {
    "category": "A|B|C|D|E",
    "label": "e.g. Excitement Problem",
    "description": "2-3 sentence plain-English explanation of what you found",
    "evidence": ["specific data point 1", "specific data point 2", "specific data point 3"],
    "severity": "low|medium|high"
  },
  "objective": "One clear sentence describing the marketing goal",
  "magicQuestion": "A compelling question that captures why someone should visit TODAY",
  "campaigns": [
    {
      "name": "Campaign Name",
      "type": "Campaign Type",
      "goal": "What this achieves",
      "strategy": "2-3 sentences describing the approach",
      "tactics": ["specific action 1", "specific action 2", "specific action 3", "specific action 4"],
      "timeline": "e.g. 1 week, ongoing, monthly",
      "expectedImpact": "e.g. +20-30% weekend traffic",
      "magicQuestion": "Why should a customer come THIS [day/week]?",
      "priority": 1
    }
  ],
  "contentTemplates": {
    "instagramCaption": "Ready-to-post Instagram caption for the top campaign (include hashtags, emojis)",
    "smsMessage": "Short SMS message under 160 characters for the top campaign",
    "posterHeadline": "Bold poster headline (max 8 words) + 1 subheading line",
    "emailSubject": "Email subject line for the top campaign"
  },
  "advice": "2-3 sentences of direct, personal strategic advice to the restaurant manager"
}

CRITICAL: Output ONLY the JSON object. No introduction, no explanation, no markdown except for the json code fence if needed.`
}

function buildContentPrompt(campaign: any, snapshot: any): string {
  return `You are Jesse, a creative restaurant marketing copywriter. Generate fresh marketing content for this campaign.

CAMPAIGN:
${JSON.stringify(campaign, null, 2)}

RESTAURANT CONTEXT:
- Best selling dish: ${snapshot.topDishes?.[0]?.name ?? 'their signature dish'}
- Best day: ${snapshot.bestDay}
- Revenue trend: ${snapshot.trend?.direction}

Generate creative, ready-to-use marketing content. Return ONLY this JSON:
{
  "instagramCaption": "Full Instagram caption with emojis and hashtags (150-200 chars)",
  "instagramStoryText": "Short punchy text for an Instagram story (max 50 chars)",
  "smsMessage": "SMS blast under 160 characters with urgency",
  "posterHeadline": "Bold poster headline (max 8 words)",
  "posterSubheading": "Supporting subheading (max 15 words)",
  "emailSubject": "Email subject line (max 50 chars)",
  "emailPreview": "Email preview text (max 90 chars)",
  "tiktokHook": "First 3 seconds TikTok video hook line",
  "adCopy": "Short Facebook/Instagram ad copy (max 100 words)"
}

Make the content specific, exciting, and action-driving. Use the campaign name and goal naturally.`
}

function buildChatPrompt(message: string, context: any, snapshot: any): string {
  return `You are Jesse, a sharp restaurant marketing strategist. You are having a conversation with a restaurant manager about their marketing strategy.

CURRENT MARKETING CONTEXT:
${context ? JSON.stringify(context, null, 2) : 'No specific campaign context'}

RESTAURANT DATA SUMMARY:
- Revenue trend: ${snapshot.trend?.direction} (${snapshot.trend?.changePercent}% this week vs last)
- Best selling dish: ${snapshot.topDishes?.[0]?.name ?? 'N/A'}
- Best day: ${snapshot.bestDay}
- Worst day: ${snapshot.worstDay}

MANAGER'S QUESTION:
${message}

RESPONSE STYLE:
- Be direct, confident, and practical
- Give specific, actionable advice tied to their real data
- Use short paragraphs with line breaks
- No jargon — talk like a smart mentor
- End with a follow-up question to keep the conversation going
- Max 3 paragraphs`
}

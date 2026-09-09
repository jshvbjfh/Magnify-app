import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import {
  blocksFurtherSales,
  planPrintRecovery,
  PRINT_JOB_STATES,
  type PrintJob,
} from '@/lib/fiscalPrintRecovery'

export const dynamic = 'force-dynamic'

// Recovering an interrupted print (§7.28).
//
//   "continue or re-print last line in the case of power failure or after
//    missing paper recovery"
//
//   GET    what, if anything, was interrupted at this outlet
//   POST   a print is starting
//   PATCH  lines confirmed, or the print finished or failed
//
// ── The state a crash actually leaves behind ────────────────────────────────
//
// Nothing marks itself INTERRUPTED. A till that loses power mid-receipt does
// not get to write a row on the way down — it simply stops, leaving the job at
// PRINTING. So a job found PRINTING when the app starts is, by definition,
// interrupted: nothing has been printing since the process died.
//
// GET therefore promotes stale PRINTING rows to INTERRUPTED before planning
// recovery. Without that step the recovery logic would be handed a job it reads
// as healthy and would answer "nothing to do", which is exactly the silence
// §7.28 exists to prevent.
//
// ── Why this can block trade ────────────────────────────────────────────────
//
// A sale whose receipt never completed has been registered without a receipt,
// which §7.15 forbids. The response carries `blocksFurtherSales` so the till
// stops rather than opening the next table — not because a printer is broken,
// but because the last sale is not lawfully recorded yet.

/** The row as lib/fiscalPrintRecovery wants to see it. */
function toPrintJob(row: {
  id: string
  fiscalReceiptId: string | null
  state: string
  totalLines: number
  linesPrinted: number
  originalCompleted: boolean
}): PrintJob {
  return {
    id: row.id,
    fiscalReceiptId: row.fiscalReceiptId,
    state: row.state as PrintJob['state'],
    totalLines: row.totalLines,
    linesPrinted: row.linesPrinted,
    originalCompleted: row.originalCompleted,
  }
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const branchId = context?.branchId ?? null
  if (!branchId) return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })

  // A job left PRINTING is a job whose process died. Promote before planning.
  await prisma.fiscalPrintJob.updateMany({
    where: { branchId, state: PRINT_JOB_STATES.PRINTING },
    data: { state: PRINT_JOB_STATES.INTERRUPTED, lastError: 'Printing stopped unexpectedly' },
  })

  const job = await prisma.fiscalPrintJob.findFirst({
    where: { branchId, state: PRINT_JOB_STATES.INTERRUPTED },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, fiscalReceiptId: true, state: true,
      totalLines: true, linesPrinted: true, originalCompleted: true, lastError: true,
    },
  })

  if (!job) {
    return NextResponse.json({ job: null, recovery: { action: 'none' }, blocksFurtherSales: false })
  }

  const asJob = toPrintJob(job)

  return NextResponse.json({
    job: { ...job },
    recovery: planPrintRecovery(asJob),
    blocksFurtherSales: blocksFurtherSales(asJob),
  })
}

// POST — a print is starting.
//
//   { fiscalReceiptId?, totalLines }
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const fiscalReceiptId = typeof body.fiscalReceiptId === 'string' && body.fiscalReceiptId.trim()
    ? body.fiscalReceiptId.trim()
    : null
  const totalLines = Number(body.totalLines)

  if (!Number.isFinite(totalLines) || totalLines <= 0) {
    return NextResponse.json({ error: 'How many lines is the receipt?' }, { status: 400 })
  }

  // §7.18 — one original per sale, ever. If an original has already completed
  // for this receipt, the next print is a COPY and the caller is told so rather
  // than being allowed to put a second original into the world.
  const priorOriginal = fiscalReceiptId
    ? await prisma.fiscalPrintJob.findFirst({
        where: { fiscalReceiptId, originalCompleted: true },
        select: { id: true },
      })
    : null

  const job = await prisma.fiscalPrintJob.create({
    data: {
      restaurantId,
      branchId,
      fiscalReceiptId,
      state: PRINT_JOB_STATES.PRINTING,
      totalLines: Math.floor(totalLines),
      linesPrinted: 0,
      originalCompleted: false,
    },
    select: { id: true, state: true, totalLines: true, linesPrinted: true },
  })

  return NextResponse.json({ ...job, mustPrintAsCopy: Boolean(priorOriginal) }, { status: 201 })
}

// PATCH — progress, completion, or failure.
//
//   { id, linesPrinted?, state? }
export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const branchId = context?.branchId ?? null
  if (!branchId) return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const id = String(body.id ?? '').trim()
  if (!id) return NextResponse.json({ error: 'Which print job?' }, { status: 400 })

  const existing = await prisma.fiscalPrintJob.findFirst({
    where: { id, branchId },
    select: { id: true, totalLines: true, linesPrinted: true, originalCompleted: true },
  })
  if (!existing) return NextResponse.json({ error: 'Print job not found' }, { status: 404 })

  const rawState = String(body.state ?? '').trim().toUpperCase()
  const state = (Object.values(PRINT_JOB_STATES) as string[]).includes(rawState) ? rawState : null

  const rawLines = Number(body.linesPrinted)
  // Never allowed to go backwards. A confirmation arriving out of order would
  // otherwise rewind the resume point and reprint lines the guest already has.
  const linesPrinted = Number.isFinite(rawLines)
    ? Math.max(existing.linesPrinted, Math.min(Math.floor(rawLines), existing.totalLines))
    : existing.linesPrinted

  const completing = state === PRINT_JOB_STATES.COMPLETED

  const job = await prisma.fiscalPrintJob.update({
    where: { id: existing.id },
    data: {
      ...(state ? { state } : {}),
      linesPrinted: completing ? existing.totalLines : linesPrinted,
      // Set once and never unset: this is what stops a later recovery printing
      // a second original.
      ...(completing ? { originalCompleted: true } : {}),
      ...(typeof body.lastError === 'string' ? { lastError: body.lastError.trim() || null } : {}),
    },
    select: {
      id: true, fiscalReceiptId: true, state: true,
      totalLines: true, linesPrinted: true, originalCompleted: true,
    },
  })

  const asJob = toPrintJob(job)

  return NextResponse.json({
    ...job,
    recovery: planPrintRecovery(asJob),
    blocksFurtherSales: blocksFurtherSales(asJob),
  })
}

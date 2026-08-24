import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { jwtVerify } from 'jose'
import { resolveActiveStaffAccess } from '@/lib/mobileStaffAccess'

export const dynamic = 'force-dynamic'

const SECRET = new TextEncoder().encode(
  process.env.NEXTAUTH_SECRET ?? 'fallback-secret-change-me'
)

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0, must-revalidate',
}

// Job titles that carry supervisor standing on the floor. Compared lowercased
// against Staff.role, whose allowed values are set by the employees API.
// 'supervisor' is not one of them today; it is listed so adding it to that
// list later needs no change here.
const SUPERVISOR_ROLES = new Set(['manager', 'supervisor'])

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...NO_STORE_HEADERS,
      ...(init?.headers ?? {}),
    },
  })
}

async function verifyToken(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) throw new Error('Unauthorized')
  const { payload } = await jwtVerify(token, SECRET)
  return payload as { sub: string; restaurantId: string; branchId: string | null; role: string }
}

/** GET /api/mobile/pull — returns dishes + tables for the waiter's branch */
export async function GET(req: Request) {
  try {
    const claims = await verifyToken(req)

    // Use the staff record's CURRENT binding, never the JWT's point-in-time
    // claims: deactivated or reassigned staff must lose access immediately,
    // not whenever their token happens to expire.
    const staffAccess = await resolveActiveStaffAccess(claims.sub)
    if (!staffAccess) {
      return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
    }

    const restaurantId = staffAccess.restaurantId
    const userBranchId = staffAccess.branchId

    if (!userBranchId) {
      return jsonNoStore(
        { error: 'Your account has no station assigned. Ask your manager to assign a station before using the waiter app.' },
        { status: 403 }
      )
    }

    // Optional branch override: waiter app sends ?branchId= when user taps a branch chip.
    // Validate the requested branch belongs to this restaurant before accepting it.
    const url = new URL(req.url)
    const requestedBranchId = url.searchParams.get('branchId')
    let effectiveBranchId = userBranchId

    if (requestedBranchId && requestedBranchId !== userBranchId) {
      const validBranch = await prisma.branch.findFirst({
        where: { id: requestedBranchId, restaurantId, isActive: true },
        select: { id: true },
      })
      if (!validBranch) {
        return jsonNoStore({ error: 'Station not found or not accessible.' }, { status: 403 })
      }
      effectiveBranchId = requestedBranchId
    }

    // Dishes are shared across all branches on the unified waiter menu.
    // Each dish retains its branchId for sale attribution — do not filter here.
    // deletedAt matters: soft-deleted dishes keep isActive=true, and without
    // this filter every deleted dish kept re-appearing on waiter terminals.
    const dishWhere = { restaurantId, isActive: true, deletedAt: null }

    // Tables are restaurant-wide: all branch tables appear on the floor plan.
    const tableWhere = { restaurantId }

    // Recent orders window: last 3 days so waiter sees status changes (PAID/CANCELLED)
    // made by the manager without re-pushing. Scoped to the waiter's branch.
    const recentOrderSince = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)

    // "Today" window for MEP log reconciliation (server timezone — the device's
    // own local log list is the primary UI source).
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)

    // Catalog data — the menu, tables, staff, stations, MEP and stock — changes
    // a few times a week. Orders change every minute. Both were being fetched
    // together every 10 seconds by every device, which is what put the database
    // under load: twelve queries a poll, six polls a minute, per till and per
    // tablet, almost all of it re-reading rows nobody had touched.
    //
    // ?catalog=0 asks for the order half only. A client that knows to send it
    // pulls the catalog on startup and every few minutes after; the rest of the
    // time it costs four queries instead of twelve.
    //
    // Opt-in from the client on purpose. Devices in the field run older builds
    // that read payload.dishes.length unguarded and warn — or throw — on an
    // empty menu. They never send the flag, so they keep the full payload and
    // behave exactly as before.
    const catalogRequested = url.searchParams.get('catalog') !== '0'
    const skip = <T,>(value: T) => Promise.resolve(value)

    // A poll costs the same whether anything happened or not. The order half is
    // four queries that re-send up to five hundred orders and every line on
    // them, and a device asks every ten seconds — so a quiet afternoon is
    // thousands of byte-for-byte re-sends of what the till already has. That,
    // not the amount of data stored, is what exhausted the transfer allowance:
    // the whole database is around twenty megabytes and we shipped five
    // gigabytes in three weeks.
    //
    // changeToken summarises everything the order half can return. The device
    // sends back the one it last saw; if it still matches, nothing has moved and
    // the reply is a few bytes instead of tens of kilobytes. The interval is
    // deliberately unchanged — only the cost of an unchanged answer falls — so
    // nothing on the floor goes staler than it already was. Making polls cheap
    // is safe; making them rarer is what would put a wrong order on a table.
    //
    // The token has to span every source the order half reads, or a device
    // silently misses a change:
    //   - the orders themselves
    //   - their LINES, which move without touching the order row: adding a dish
    //     writes an OrderItem and leaves restaurant_orders.updatedAt alone
    //   - the restaurant row (bill header, printers, shift gating)
    //   - the open shift, which gates the till
    //
    // Each carries a count as well as max(updatedAt), because a delete lowers
    // the count while leaving every surviving row's timestamp untouched — and
    // orders do get deleted, from the Transactions page. Timestamps alone would
    // strand a removed order on the floor for ever.
    //
    // Every filter below mirrors the corresponding query exactly. A token more
    // sensitive than its query only costs a needless refetch; one less sensitive
    // loses a change, so when in doubt these must match rather than approximate.
    const sinceToken = url.searchParams.get('since')
    const [orderStat, itemStat, restaurantStat, shiftStat] = await Promise.all([
      prisma.restaurantOrder.aggregate({
        where: { restaurantId, deletedAt: null, updatedAt: { gte: recentOrderSince } },
        _count: { _all: true },
        _max: { updatedAt: true },
      }),
      prisma.orderItem.aggregate({
        where: { status: 'ACTIVE', order: { restaurantId, deletedAt: null } },
        _count: { _all: true },
        _max: { updatedAt: true },
      }),
      prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { updatedAt: true },
      }),
      prisma.shift.aggregate({
        where: { restaurantId, status: 'OPEN', deletedAt: null },
        _count: { _all: true },
        _max: { updatedAt: true },
      }),
    ])

    const stamp = (value: Date | null | undefined) => (value ? value.getTime() : 0)
    const changeToken = [
      `o${orderStat._count._all}.${stamp(orderStat._max.updatedAt)}`,
      `i${itemStat._count._all}.${stamp(itemStat._max.updatedAt)}`,
      `r${stamp(restaurantStat?.updatedAt)}`,
      `s${shiftStat._count._all}.${stamp(shiftStat._max.updatedAt)}`,
    ].join('-')

    // The catalog half needs exactly the same treatment, and for a bigger prize.
    // It refreshes every sixty seconds and ships all 231 dishes plus tables,
    // staff, stations, MEP and preps each time — around 75KB against the order
    // half's 20KB. At roughly 1,300 refreshes a day that is the larger share of
    // the bill, and the menu changes a few times a WEEK.
    //
    // Same rule as above: the interval stays at sixty seconds so a dish marked
    // out still reaches the floor within a minute. Only an unchanged answer gets
    // cheaper. Every filter mirrors its query, including the ones that move
    // during service (MEP items, prep logs, stock counts) — a menu that has not
    // changed must not mask a prep list that has.
    const catalogSince = url.searchParams.get('catalogSince')
    let catalogToken: string | null = null
    if (catalogRequested) {
      const [dishStat, tableStat, staffStat, branchStat, mepStat, prepLogStat, prepStat] = await Promise.all([
        prisma.dish.aggregate({ where: dishWhere, _count: { _all: true }, _max: { updatedAt: true } }),
        prisma.restaurantTable.aggregate({ where: tableWhere, _count: { _all: true }, _max: { updatedAt: true } }),
        prisma.staff.aggregate({
          where: {
            restaurantId,
            isActive: true,
            deletedAt: null,
            OR: [{ pin: { not: null } }, { cancellationPin: { not: null } }],
          },
          _count: { _all: true },
          _max: { updatedAt: true },
        }),
        prisma.branch.aggregate({
          where: { restaurantId, isActive: true },
          _count: { _all: true },
          _max: { updatedAt: true },
        }),
        prisma.mepListItem.aggregate({
          where: { restaurantId, branchId: effectiveBranchId, deletedAt: null },
          _count: { _all: true },
          _max: { updatedAt: true },
        }),
        prisma.prepLog.aggregate({
          where: { restaurantId, branchId: effectiveBranchId, madeAt: { gte: startOfToday } },
          _count: { _all: true },
          _max: { updatedAt: true },
        }),
        prisma.inventoryItem.aggregate({
          where: { restaurantId, branchId: effectiveBranchId, type: 'prep', deletedAt: null },
          _count: { _all: true },
          _max: { updatedAt: true },
        }),
      ])

      catalogToken = [
        `d${dishStat._count._all}.${stamp(dishStat._max.updatedAt)}`,
        `t${tableStat._count._all}.${stamp(tableStat._max.updatedAt)}`,
        `f${staffStat._count._all}.${stamp(staffStat._max.updatedAt)}`,
        `b${branchStat._count._all}.${stamp(branchStat._max.updatedAt)}`,
        `m${mepStat._count._all}.${stamp(mepStat._max.updatedAt)}`,
        `l${prepLogStat._count._all}.${stamp(prepLogStat._max.updatedAt)}`,
        `p${prepStat._count._all}.${stamp(prepStat._max.updatedAt)}`,
      ].join('-')
    }

    // Asked for, but not a byte of it has moved — so the device keeps the copy
    // it already has. Distinct from "not asked for": the client has to reset its
    // catalog clock on this, or it would ask again ten seconds later and pay for
    // the check on every single poll.
    const catalogUnchanged = Boolean(catalogRequested && catalogSince && catalogSince === catalogToken)
    const sendCatalog = catalogRequested && !catalogUnchanged

    // Nothing has moved on either half, so there is nothing to send at all. This
    // is the common case on a quiet floor and the entire point of the tokens. A
    // device that sends neither ?since= nor ?catalogSince= never reaches this
    // branch and keeps the old behaviour exactly.
    if (sinceToken && sinceToken === changeToken && !sendCatalog) {
      return jsonNoStore({
        unchanged: true,
        changeToken,
        catalogToken,
        catalogUnchanged,
        catalogIncluded: false,
      })
    }

    const [dishes, tables, restaurant, approverEmployees, allBranches, recentOrders, incomingOrders, mepItems, mepTodayLogs, prepCatalog, openShift] = await Promise.all([
      sendCatalog ? prisma.dish.findMany({
        where: dishWhere,
        select: {
          id: true, name: true, sellingPrice: true,
          category: true, menuType: true, isActive: true, branchId: true, restaurantId: true,
          preparedPortions: true,
        },
        orderBy: { name: 'asc' },
      }) : Promise.resolve([]),

      sendCatalog ? prisma.restaurantTable.findMany({
        where: tableWhere,
        select: {
          id: true, name: true, seats: true, status: true,
          branchId: true, restaurantId: true,
        },
        orderBy: { name: 'asc' },
      }) : Promise.resolve([]),

      prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { id: true, name: true, billHeader: true, billPrinterIp: true, billPrinterPort: true, shiftsEnabled: true, printPaymentConfirmation: true },
      }),

      // Staff with a stored order code (pin) can confirm orders offline.
      // Staff with a stored cancellationPin can approve order cancellations offline.
      // Restaurant-wide, not scoped to effectiveBranchId — order codes and
      // cancellation PINs identify a *person*, not a station, so anyone on
      // staff can confirm/cancel regardless of which station tab is active.
      // Hashes are sent, never plaintext.
      sendCatalog ? prisma.staff.findMany({
        where: {
          restaurantId,
          isActive: true,
          deletedAt: null,
          OR: [{ pin: { not: null } }, { cancellationPin: { not: null } }],
        },
        select: { id: true, name: true, role: true, pin: true, cancellationPin: true },
      }) : Promise.resolve([]),

      sendCatalog ? prisma.branch.findMany({
        where: { restaurantId, isActive: true },
        select: { id: true, name: true, code: true, isMain: true, type: true },
        orderBy: { name: 'asc' },
      }) : Promise.resolve([]),

      // Recent order status updates — restaurant-wide so any branch's changes reconcile locally.
      prisma.restaurantOrder.findMany({
        where: {
          restaurantId,
          // Soft-deleted orders must not come back down. The waiter apps purge
          // any local order the server stops listing, so leaving these in kept a
          // removed order alive on every till for ever — an owner deleting a
          // mistake order watched it reappear on the floor.
          deletedAt: null,
          updatedAt: { gte: recentOrderSince },
        },
        select: {
          id: true,
          status: true,
          paymentMethod: true,
          paidAt: true,
          canceledAt: true,
          cancelReason: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),

      // Active orders + recent PAID/CANCELED (last 3 days) so the owner's device
      // has revenue history on a fresh install without relying on push-side data.
      prisma.restaurantOrder.findMany({
        where: {
          restaurantId,
          deletedAt: null,
          OR: [
            // UNCONFIRMED = guest QR orders awaiting a waiter's confirmation.
            // They must reach the waiter device so the waiter can confirm them.
            { status: { in: ['PENDING', 'OPEN', 'UNCONFIRMED'] } },
            { status: { in: ['PAID', 'CANCELED'] }, updatedAt: { gte: recentOrderSince } },
          ],
        },
        select: {
          id: true,
          restaurantId: true,
          branchId: true,
          tableId: true,
          tableName: true,
          orderNumber: true,
          status: true,
          paymentMethod: true,
          subtotalAmount: true,
          vatAmount: true,
          totalAmount: true,
          createdByName: true,
          // Which app took it — the till shows a Push button only for orders a
          // tablet rang up, since nothing has printed their tickets.
          source: true,
          paidAt: true,
          canceledAt: true,
          cancelReason: true,
          createdAt: true,
          updatedAt: true,
          items: {
            where: { status: 'ACTIVE' },
            select: {
              id: true,
              orderId: true,
              dishId: true,
              dishName: true,
              dishPrice: true,
              qty: true,
              status: true,
              notes: true,
              branchId: true,
              discountPercent: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 300,
      }),

      // MEP list for this station — persists until removed by staff.
      sendCatalog ? prisma.mepListItem.findMany({
        where: { restaurantId, branchId: effectiveBranchId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }) : Promise.resolve([]),

      // Today's prep logs for offline reconciliation on the device.
      sendCatalog ? prisma.prepLog.findMany({
        where: { restaurantId, branchId: effectiveBranchId, madeAt: { gte: startOfToday } },
        orderBy: { madeAt: 'desc' },
        take: 200,
      }) : Promise.resolve([]),

      // Prep catalog for the MEP search box (dishes come from the dishes array).
      sendCatalog ? prisma.inventoryItem.findMany({
        where: { restaurantId, branchId: effectiveBranchId, type: 'prep', deletedAt: null },
        select: { id: true, name: true, unit: true, quantity: true },
        orderBy: { name: 'asc' },
      }) : Promise.resolve([]),

      // Current open service session (whole-venue). Earliest-opened wins if two
      // ever exist (concurrent offline opens), so every terminal converges on the
      // same shift for its start/end gating.
      prisma.shift.findFirst({
        where: { restaurantId, status: 'OPEN', deletedAt: null },
        orderBy: { openedAt: 'asc' },
        select: {
          id: true, restaurantId: true, businessDate: true, status: true,
          openedAt: true, openedByName: true, openedByStaffId: true,
          closedAt: true, closedByName: true, closedByStaffId: true,
          sourceDeviceId: true, createdAt: true, updatedAt: true,
        },
      }),
    ])

    // Normalise Prisma Decimal → number for SQLite
    const normalisedDishes = dishes.map(d => ({
      id: d.id,
      name: d.name,
      selling_price: Number(d.sellingPrice),
      category: d.category ?? null,
      menu_type: d.menuType ?? null,
      is_active: d.isActive ? 1 : 0,
      branch_id: d.branchId ?? null,
      restaurant_id: d.restaurantId,
      prepared_portions: Number(d.preparedPortions ?? 0),
    }))

    // Resolve MEP target names/remaining server-side so the device never needs
    // an inventory table. Targets that no longer resolve are skipped.
    const prepById = new Map(prepCatalog.map(p => [p.id, p]))
    const dishById = new Map(dishes.map(d => [d.id, d]))
    const normalisedMepItems = mepItems.flatMap(item => {
      if (item.targetType === 'prep') {
        const prep = prepById.get(item.targetId)
        if (!prep) return []
        return [{
          id: item.id,
          restaurant_id: item.restaurantId,
          branch_id: item.branchId,
          target_type: 'prep',
          target_id: item.targetId,
          name: prep.name,
          unit: prep.unit ?? null,
          remaining: Number(prep.quantity ?? 0),
          updated_at: item.updatedAt.toISOString(),
        }]
      }
      const dish = dishById.get(item.targetId)
      if (!dish) return []
      return [{
        id: item.id,
        restaurant_id: item.restaurantId,
        branch_id: item.branchId,
        target_type: 'dish',
        target_id: item.targetId,
        name: dish.name,
        unit: 'portion',
        remaining: Number(dish.preparedPortions ?? 0),
        updated_at: item.updatedAt.toISOString(),
      }]
    })

    const normalisedTables = tables.map(t => ({
      id: t.id,
      name: t.name,
      seats: t.seats ?? null,
      status: t.status ?? 'available',
      branch_id: t.branchId ?? null,
      restaurant_id: t.restaurantId,
    }))

    // Diagnostic: log when a pull that ASKED for the menu comes back empty, so
    // server logs carry the branchId without needing a debugger.
    //
    // Guarded on catalogRequested. A light pull returns no dishes and no tables
    // by design, so without this it fired on every single one — 2,485 false
    // alarms in eleven minutes, all of them reading as if a station had lost its
    // menu while the restaurant in question had 231 active dishes the whole
    // time. A warning that cries wolf on the happy path is worse than none.
    if (sendCatalog && normalisedDishes.length === 0) {
      console.warn('[mobile/pull] zero dishes returned', {
        restaurantId,
        branchId: effectiveBranchId,
        tablesCount: normalisedTables.length,
      })
    }

    // Restaurant-wide receipt template the manager edits in Settings.
    // The waiter device prints exactly this.
    return jsonNoStore({
      dishes: normalisedDishes,
      tables: normalisedTables,
      // shiftsEnabled tells the till whether to gate on a service shift at all.
      // It defaults to true when the restaurant row is missing so a lookup blip
      // can never silently drop a venue out of its shift discipline.
      restaurant: restaurant
        ? { id: restaurant.id, name: restaurant.name, billHeader: restaurant.billHeader ?? '', billPrinterIp: restaurant.billPrinterIp ?? '', billPrinterPort: restaurant.billPrinterPort ?? null, shifts_enabled: restaurant.shiftsEnabled, print_payment_confirmation: restaurant.printPaymentConfirmation }
        // A lookup blip must not silently switch a venue's slips off, but it
        // must not switch them on either — false is the setting every venue
        // starts with, so it is the honest fallback.
        : { id: restaurantId, name: 'Restaurant', billHeader: '', billPrinterIp: '', billPrinterPort: null, shifts_enabled: true, print_payment_confirmation: false },
      // Tells the client which half it received. Without it a light pull looks
      // identical to a restaurant whose menu really is empty, and the client
      // warns the waiter their station has no menu.
      catalogIncluded: sendCatalog,
      // True when the catalog was asked for and had not changed, so the device
      // keeps its cached menu AND resets its catalog clock. Without the reset it
      // would ask again on the very next poll and pay for the check every time.
      catalogUnchanged,
      // What the device sends back as ?since= / ?catalogSince= next time. When
      // they still match, the next pull answers in a few bytes instead of
      // resending everything.
      changeToken,
      catalogToken,
      branches: allBranches,
      cancellationApprovers: approverEmployees
        .filter(e => e.cancellationPin != null)
        .map(e => ({
          id: e.id,
          name: e.name,
          pin_hash: e.cancellationPin as string,
        })),
      // is_supervisor marks the people who may act on ANY waiter's table from
      // the till, not just their own: a Manager, or anyone trusted with a
      // cancellation PIN (this app's existing supervisor credential — it
      // already approves cancellations and opens/closes shifts). Sent as a
      // flag rather than the role string so the waiter apps never have to
      // agree on the restaurant's job titles.
      orderCodeHolders: approverEmployees
        .filter(e => e.pin != null)
        .map(e => ({
          id: e.id,
          name: e.name,
          pin_hash: e.pin as string,
          is_supervisor: e.cancellationPin != null || SUPERVISOR_ROLES.has(String(e.role ?? '').trim().toLowerCase()),
        })),
      // Recent order status updates for local reconciliation on the waiter device.
      // Waiter app can update matching local rows without re-pushing.
      recentOrders: recentOrders.map(o => ({
        id: o.id,
        status: o.status,
        payment_method: o.paymentMethod ?? null,
        paid_at: o.paidAt?.toISOString() ?? null,
        canceled_at: o.canceledAt?.toISOString() ?? null,
        cancel_reason: o.cancelReason ?? null,
        updated_at: o.updatedAt.toISOString(),
      })),

      // Full active orders the waiter app may not have locally (e.g. QR/guest orders).
      // Same shape as the push payload so the waiter app can upsert them into SQLite.
      incomingOrders: incomingOrders.map(o => ({
        id: o.id,
        restaurant_id: o.restaurantId,
        branch_id: o.branchId,
        table_id: o.tableId ?? null,
        table_name: o.tableName ?? null,
        order_number: o.orderNumber,
        status: o.status,
        payment_method: o.paymentMethod ?? null,
        subtotal_amount: Number(o.subtotalAmount),
        vat_amount: Number(o.vatAmount),
        total_amount: Number(o.totalAmount),
        created_by_name: o.createdByName ?? null,
        source: o.source ?? null,
        paid_at: o.paidAt?.toISOString() ?? null,
        canceled_at: o.canceledAt?.toISOString() ?? null,
        cancel_reason: o.cancelReason ?? null,
        created_at: o.createdAt.toISOString(),
        updated_at: o.updatedAt.toISOString(),
        items: o.items.map(item => ({
          id: item.id,
          order_id: item.orderId,
          dish_id: item.dishId,
          dish_name: item.dishName,
          dish_price: Number(item.dishPrice),
          qty: item.qty,
          status: item.status,
          notes: item.notes,
          // The station the line was rung up on. Without it the till groups a
          // pushed ticket by its own dish list, which only holds its own
          // station, and every slip lands on the bill printer.
          branch_id: item.branchId ?? null,
          discount_percent: item.discountPercent ?? null,
          created_at: item.createdAt.toISOString(),
          updated_at: item.updatedAt.toISOString(),
        })),
      })),

      // Current open shift (null when the venue is closed). The waiter app uses
      // this to decide: shift open → straight to the waiter-code screen; none →
      // prompt a supervisor to start one. snake_case to match the local schema.
      openShift: openShift
        ? {
            id: openShift.id,
            restaurant_id: openShift.restaurantId,
            business_date: openShift.businessDate.toISOString(),
            status: openShift.status,
            opened_at: openShift.openedAt.toISOString(),
            opened_by_name: openShift.openedByName ?? null,
            opened_by_staff_id: openShift.openedByStaffId ?? null,
            closed_at: openShift.closedAt?.toISOString() ?? null,
            closed_by_name: openShift.closedByName ?? null,
            closed_by_staff_id: openShift.closedByStaffId ?? null,
            source_device_id: openShift.sourceDeviceId ?? null,
            created_at: openShift.createdAt.toISOString(),
            updated_at: openShift.updatedAt.toISOString(),
          }
        : null,

      // MEP: per-station prep list + today's logs + prep catalog for the search box.
      mep: {
        items: normalisedMepItems,
        todayLogs: mepTodayLogs.map(log => ({
          id: log.id,
          client_log_id: log.clientLogId ?? null,
          target_type: log.targetType,
          target_id: log.targetId,
          name: log.targetType === 'prep'
            ? (prepById.get(log.targetId)?.name ?? null)
            : (dishById.get(log.targetId)?.name ?? null),
          quantity: Number(log.quantity),
          unit: log.unit ?? null,
          made_by: log.madeBy ?? null,
          made_at: log.madeAt.toISOString(),
          reversed: log.reversedAt ? 1 : 0,
        })),
        preps: prepCatalog.map(p => ({
          id: p.id,
          name: p.name,
          unit: p.unit ?? null,
          remaining: Number(p.quantity ?? 0),
        })),
      },
    })
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[mobile/pull]', err)
    return jsonNoStore({ error: 'Server error' }, { status: 500 })
  }
}

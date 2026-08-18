// ── Hotel buffet settles on credit — SIROCCO Y SOL ONLY ────────────────────
//
// This is a one-off arrangement with one hotel, not a product feature. The
// hotel sends its guests to breakfast and settles with the restaurant itself,
// later. So for that account HOTEL BUFFET *is* credit: its amount never lands
// in the till, it books to Accounts Receivable as money the hotel owes. That
// holds for every buffet line, whether the guest added anything to it or not.
//
// Scoped to a single restaurant ID on purpose. Keying only off the dish name
// would mean any restaurant that ever names a dish "HOTEL BUFFET" silently
// stops charging for it — so every caller must pass the restaurant, and the
// compiler enforces it rather than trusting each call site to remember. If a
// second hotel ever needs this, do NOT add another ID: promote it to a
// per-restaurant setting the way sharedStock works.
//
// Two separate rules come out of this, and they must not be confused:
//
//   hotelCreditLines()       — which lines settle as a receivable instead of
//                              cash. Every buffet line, always. Drives the
//                              accounting split and the "due at table" figure.
//
//   hotelBuffetPriceHidden() — which lines print with no price on the bill.
//                              Only a buffet that SHARES the order with items
//                              the guest is paying for: that slip is the
//                              guest's, and the buffet is not theirs to pay, so
//                              showing an amount they do not owe only causes an
//                              argument. A buffet ordered on its own still
//                              prints its price, because that slip is the record
//                              of the cover the hotel is being charged for.
//
// Server-side twin: lib/hotelBuffet.ts, which does the actual journal split at
// payment. The desktop app ships as its own bundle and cannot import from
// there, so the rule is duplicated deliberately. Keep the two in step.

const HOTEL_BUFFET_RESTAURANT_ID = 'cmssn2wif000210rcxlzs1jny' // SIROCCO Y SOL
const HOTEL_BUFFET_CATEGORY = 'breakfast buffet table'

// Category is a second guard behind the restaurant check; it is optional
// because an order item carries no category of its own and its dish may since
// have been deactivated, in which case the exact name stands alone.
export function isHotelBuffetLine(
  restaurantId: string | null | undefined,
  name: string,
  category?: string | null,
): boolean {
  if (restaurantId !== HOTEL_BUFFET_RESTAURANT_ID) return false
  if (!/^\s*hotel\s+buffet\s*$/i.test(name ?? '')) return false
  const cat = category?.trim().toLowerCase()
  return !cat || cat === HOTEL_BUFFET_CATEGORY
}

// One flag per line: true where the line is owed by the hotel on credit and so
// must book to Accounts Receivable rather than the till.
export function hotelCreditLines(
  restaurantId: string | null | undefined,
  lines: Array<{ name: string; category?: string | null }>,
): boolean[] {
  return lines.map(l => isHotelBuffetLine(restaurantId, l.name, l.category))
}

// One flag per line: true where the bill must name the line but print no
// amount against it. Only when the guest is paying for something else on the
// same order — see the note above.
export function hotelBuffetPriceHidden(
  restaurantId: string | null | undefined,
  lines: Array<{ name: string; category?: string | null }>,
): boolean[] {
  const buffet = hotelCreditLines(restaurantId, lines)
  const hasItemsTheGuestPays = buffet.some(b => !b)
  return buffet.map(b => b && hasItemsTheGuestPays)
}

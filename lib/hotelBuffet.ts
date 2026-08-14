// ── Hotel buffet settles on credit — SIROCCO Y SOL ONLY ────────────────────
//
// This is a one-off arrangement with one hotel, not a product feature. The
// hotel sends its guests to breakfast and settles with the restaurant itself,
// later. So for that account HOTEL BUFFET *is* credit: its amount never lands
// in the till, it books to Accounts Receivable as money the hotel owes.
//
// Scoped to a single restaurant ID on purpose. Keying only off the dish name
// would mean any restaurant that ever names a dish "HOTEL BUFFET" silently
// starts booking real cash as a receivable — an accounting error nobody would
// notice until the drawer failed to reconcile. Every caller must pass the
// restaurant, so the compiler enforces the scoping rather than trusting each
// call site to remember.
//
// If a second hotel ever needs this, do NOT add another ID here — promote it to
// a per-restaurant setting the way sharedStock works.
//
// Server-side twin of waiter-app-desktop/src/services/hotelBuffet.ts, which the
// POS uses to print the bill and show the waiter what to collect. The desktop
// app ships as its own bundle and cannot import from here, so the rule is
// duplicated deliberately. Keep the two in step.

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

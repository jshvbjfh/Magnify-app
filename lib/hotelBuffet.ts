// ── Hotel buffet settles on credit ─────────────────────────────────────────
//
// The hotel sends its guests to breakfast and settles with the restaurant
// itself, later. So in the system's mind HOTEL BUFFET *is* credit: its amount
// never lands in the till, it books to Accounts Receivable as money the hotel
// owes. That holds for every buffet line, whether the guest added anything to
// it or not.
//
// Server-side twin of waiter-app-desktop/src/services/hotelBuffet.ts — the POS
// uses it to show the waiter what to collect at the table and to print the
// bill; this copy is what actually splits the journal at payment. The desktop
// app ships as its own bundle and cannot import from here, so the rule is
// duplicated deliberately. Keep the two in step.
const HOTEL_BUFFET_CATEGORY = 'breakfast buffet table'

// Category is the guard that keeps this to the one account that has it; it is
// optional because an order item carries no category of its own and its dish
// may since have been deactivated, in which case the exact name stands alone.
export function isHotelBuffetLine(name: string, category?: string | null): boolean {
  if (!/^\s*hotel\s+buffet\s*$/i.test(name ?? '')) return false
  const cat = category?.trim().toLowerCase()
  return !cat || cat === HOTEL_BUFFET_CATEGORY
}

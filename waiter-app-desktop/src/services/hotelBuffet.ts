// ── Hotel buffet settles on credit ─────────────────────────────────────────
//
// The hotel sends its guests to breakfast and settles with the restaurant
// itself, later. So in the system's mind HOTEL BUFFET *is* credit: its amount
// never lands in the till, it books to Accounts Receivable as money the hotel
// owes. That is true of every buffet line, whether the guest added anything to
// it or not.
//
// Two separate rules come out of that, and they must not be confused:
//
//   hotelCreditLines()      — which lines settle as a receivable instead of
//                             cash. Every buffet line, always. Drives the
//                             accounting split and the "due at table" figure.
//
//   hotelBuffetPriceHidden() — which lines print with no price on the bill.
//                             Only a buffet that SHARES the order with items
//                             the guest is paying for: that slip is the guest's,
//                             and the buffet is not theirs to pay, so showing an
//                             amount they do not owe only causes an argument. A
//                             buffet ordered on its own still prints its price,
//                             because that slip is the record of the cover the
//                             hotel is being charged for.
//
// Pure functions with no imports: the rule decides real money, so it stays
// independently testable rather than living inside the POS page.

const HOTEL_BUFFET_CATEGORY = 'breakfast buffet table'

// Category is the guard that keeps this to the one account that has it; it is
// optional because an order item carries no category of its own and its dish
// may since have been deactivated, in which case the exact name stands alone.
export function isHotelBuffetLine(name: string, category?: string | null): boolean {
  if (!/^\s*hotel\s+buffet\s*$/i.test(name ?? '')) return false
  const cat = category?.trim().toLowerCase()
  return !cat || cat === HOTEL_BUFFET_CATEGORY
}

// One flag per line: true where the line is owed by the hotel on credit and so
// must book to Accounts Receivable rather than the till.
export function hotelCreditLines(lines: Array<{ name: string; category?: string | null }>): boolean[] {
  return lines.map(l => isHotelBuffetLine(l.name, l.category))
}

// One flag per line: true where the bill must name the line but print no
// amount against it. Only when the guest is paying for something else on the
// same order — see the note above.
export function hotelBuffetPriceHidden(lines: Array<{ name: string; category?: string | null }>): boolean[] {
  const buffet = hotelCreditLines(lines)
  const hasItemsTheGuestPays = buffet.some(b => !b)
  return buffet.map(b => b && hasItemsTheGuestPays)
}

import { describe, it, expect } from 'vitest'
import { isHotelBuffetLine, hotelCreditLines, hotelBuffetPriceHidden } from '../hotelBuffet'

// The hotel buffet is settled by the hotel as a receivable, never at the till.
// These flags decide which revenue books to Accounts Receivable and what the
// guest is shown they owe, so getting them wrong moves real money.
const BUFFET = { name: 'HOTEL BUFFET', category: 'Breakfast buffet table' }
const FALAFEL = { name: 'Falafel', category: 'Add to any bowl' }
const EGG = { name: 'Poached egg', category: 'Premium egg option' }

describe('isHotelBuffetLine', () => {
  it('matches the buffet dish in its own category, however it is cased', () => {
    expect(isHotelBuffetLine('HOTEL BUFFET', 'Breakfast buffet table')).toBe(true)
    expect(isHotelBuffetLine('  hotel buffet  ', 'breakfast BUFFET table')).toBe(true)
  })

  it('matches on the exact name alone when no category is known', () => {
    // An order item carries no category, and its dish may since have been
    // deactivated — the name has to stand on its own there.
    expect(isHotelBuffetLine('HOTEL BUFFET')).toBe(true)
    expect(isHotelBuffetLine('HOTEL BUFFET', null)).toBe(true)
  })

  it('leaves every other dish alone', () => {
    // Walk-in guests shares the category but is a normal paying cover.
    expect(isHotelBuffetLine('Walk-in guests', 'Breakfast buffet table')).toBe(false)
    expect(isHotelBuffetLine('Hotel buffet extra', 'Breakfast buffet table')).toBe(false)
    expect(isHotelBuffetLine('HOTEL BUFFET', 'Lunch plates')).toBe(false)
  })
})

describe('hotelCreditLines — what books to Accounts Receivable', () => {
  it('credits the buffet when it is the whole order', () => {
    expect(hotelCreditLines([BUFFET])).toEqual([true])
  })

  it('credits the buffet and nothing else when add-ons share the order', () => {
    // The guest pays the add-ons; the hotel owes the buffet.
    expect(hotelCreditLines([BUFFET, FALAFEL, EGG])).toEqual([true, false, false])
  })

  it('credits every buffet cover on the order', () => {
    expect(hotelCreditLines([BUFFET, BUFFET])).toEqual([true, true])
  })

  it('credits nothing on an order with no buffet', () => {
    expect(hotelCreditLines([
      { name: 'Walk-in guests', category: 'Breakfast buffet table' },
      { name: 'Avocado toast', category: 'Optional add- ons' },
    ])).toEqual([false, false])
  })
})

describe('hotelBuffetPriceHidden — what the bill prints no amount for', () => {
  it('hides the buffet price once the guest has something of their own to pay', () => {
    expect(hotelBuffetPriceHidden([BUFFET, FALAFEL])).toEqual([true, false])
  })

  it('still prints the price when the buffet is the whole order', () => {
    // That slip is the record of the cover the hotel is charged for.
    expect(hotelBuffetPriceHidden([BUFFET])).toEqual([false])
  })

  it('still prints prices when the order is nothing but buffet covers', () => {
    expect(hotelBuffetPriceHidden([BUFFET, BUFFET])).toEqual([false, false])
  })

  it('hides every buffet line when add-ons share the order', () => {
    expect(hotelBuffetPriceHidden([BUFFET, BUFFET, EGG])).toEqual([true, true, false])
  })

  it('hides nothing on an order with no buffet', () => {
    expect(hotelBuffetPriceHidden([FALAFEL, EGG])).toEqual([false, false])
  })

  it('handles an empty order', () => {
    expect(hotelBuffetPriceHidden([])).toEqual([])
    expect(hotelCreditLines([])).toEqual([])
  })
})

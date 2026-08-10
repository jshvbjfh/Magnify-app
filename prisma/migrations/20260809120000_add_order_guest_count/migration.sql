-- Number of guests (covers) seated for this order. Optional: the waiter may
-- skip it, so null means "not recorded" and must never be read as zero.
ALTER TABLE "restaurant_orders" ADD COLUMN "guestCount" INTEGER;

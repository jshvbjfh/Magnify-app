-- Restaurant-wide reports filter on restaurantId + status + the business day,
-- falling back to paidAt when an order has no shift. The existing
-- (branchId, status, createdAt) index cannot serve them because those reports
-- deliberately span every station, so each one scanned the whole order history.
--
-- IF NOT EXISTS keeps this safe to re-run against a database where the index
-- was already created by hand.
CREATE INDEX IF NOT EXISTS "restaurant_orders_restaurantId_status_businessDate_idx"
  ON "restaurant_orders"("restaurantId", "status", "businessDate");

CREATE INDEX IF NOT EXISTS "restaurant_orders_restaurantId_status_paidAt_idx"
  ON "restaurant_orders"("restaurantId", "status", "paidAt");

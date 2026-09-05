-- Money into and out of the till that is not a sale (§7.12).
--
-- The opening float counted in before service, cash dropped to the safe, a
-- payout at the door. The daily report must state the opening deposit
-- (§18.1.12), and a manager counting the drawer at close needs to know what
-- should be in it.
--
-- "amount" is ALWAYS POSITIVE and "kind" carries the direction. Storing a
-- withdrawal as a negative reads fine until someone writes a positive one by
-- mistake and it quietly ADDS money to the till — a sign error in a cash figure
-- is silent, and this shape makes it impossible.
--
-- Additive and idempotent. Nothing reads this table on a non-fiscal build.
CREATE TABLE IF NOT EXISTS "cash_movements" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "shiftId" TEXT,
    "businessDate" TIMESTAMP(3) NOT NULL,

    -- OPENING_FLOAT | DEPOSIT | WITHDRAWAL
    "kind" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "recordedByName" TEXT,
    -- Taking cash OUT needs a supervisor, the same control a cancellation
    -- takes. Null on a float or a deposit, which only ever add.
    "approvedByName" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "cash_movements_branchId_businessDate_idx"
    ON "cash_movements"("branchId", "businessDate");
CREATE INDEX IF NOT EXISTS "cash_movements_restaurantId_businessDate_idx"
    ON "cash_movements"("restaurantId", "businessDate");

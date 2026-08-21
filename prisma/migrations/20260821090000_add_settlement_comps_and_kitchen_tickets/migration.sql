-- Who settled a bill, who approved a cancellation, comped ("No Charge") bills,
-- and the numbered kitchen/bar slips. (SQLite: dev + Electron local-first.)
--
-- Purely additive: four nullable columns and one new table. Nothing existing is
-- renamed, dropped, or given a new meaning, so every report that runs today
-- reads exactly what it read before this migration.
--
-- Plain ADD COLUMN, not ADD COLUMN IF NOT EXISTS: SQLite does not support the
-- IF NOT EXISTS form on ALTER TABLE. The migration ledger is what stops this
-- running twice.

-- The supervisor who closed the bill. Separate from "createdByName" on purpose:
-- a supervisor may now settle any waiter's table, and when they do the sale must
-- still belong to the waiter who took it.
ALTER TABLE "restaurant_orders" ADD COLUMN "settledByName" TEXT;

-- The supervisor whose PIN approved a cancellation. "cancelReason" already says
-- why; this is the half the cancellation report could not show.
ALTER TABLE "restaurant_orders" ADD COLUMN "canceledByName" TEXT;

-- A comped bill: the guests eat, nothing is charged, "paymentMethod" reads
-- 'No Charge'. The reason is mandatory at the till.
ALTER TABLE "restaurant_orders" ADD COLUMN "noChargeReason" TEXT;

-- What the comp was worth at menu prices. A No Charge order's own totals are
-- zeroed, which is what keeps revenue, APC and every sales report honest without
-- each of them having to learn about comps -- so this column is the only
-- surviving record of the value written off.
ALTER TABLE "restaurant_orders" ADD COLUMN "compedAmount" REAL;

-- One row per slip that actually reached a station's printer. An order carrying
-- food and drinks produces a KOT for the kitchen and a BOT for the bar; re-firing
-- after items are added produces another of each.
--
-- "seq" restarts at 1 every business day, per station. The till assigns it
-- offline, because a ticket has to print the instant it is fired whether or not
-- the internet is up. There is deliberately NO unique constraint on it: if a
-- venue ever runs two tills against one station and both are offline at once,
-- both can pick the same number, and a duplicate slip number on a report is a
-- far smaller problem than a push that will not sync.
CREATE TABLE IF NOT EXISTS "kitchen_tickets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "businessDate" DATETIME NOT NULL,
    "printedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "kitchen_tickets_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "kitchen_tickets_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "restaurant_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "kitchen_tickets_restaurantId_businessDate_idx" ON "kitchen_tickets"("restaurantId", "businessDate");
CREATE INDEX IF NOT EXISTS "kitchen_tickets_branchId_businessDate_seq_idx" ON "kitchen_tickets"("branchId", "businessDate", "seq");
CREATE INDEX IF NOT EXISTS "kitchen_tickets_orderId_idx" ON "kitchen_tickets"("orderId");

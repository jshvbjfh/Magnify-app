-- Rwanda EBM (RRA) fiscalisation — structure only.
--
-- Every column here is nullable or defaulted, and only a fiscal BUILD reads any
-- of it. Applying this migration changes no venue's behaviour and no venue's
-- figures.
--
-- Note what is NOT here: there is no "fiscal mode" column. Whether VAT is
-- charged is decided by which build is installed (lib/fiscalMode.ts), never by
-- a row. A certified system must have no off switch, and a boolean in the
-- database is one — reachable by anyone with database access, and invisible on
-- the receipt when someone flips it.
--
-- Additive and idempotent throughout: no column is dropped, renamed or
-- retyped, so a build running against a database that already has these is a
-- no-op rather than a failure.

-- ── Taxpayer identity ───────────────────────────────────────────────────────
-- The TIN printed on every fiscal receipt. Null means "not registered with RRA
-- yet", which on a fiscal build stops the till trading rather than letting it
-- trade untaxed.
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "tin" TEXT;

-- ── Per-outlet fiscal identity ──────────────────────────────────────────────
-- RRA issues these per outlet, not per taxpayer, so they live on the branch.
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "rraBranchCode" TEXT;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "sdcId" TEXT;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "mrc" TEXT;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "vsdcUrl" TEXT;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "deviceSerial" TEXT;

-- ── Item registration ───────────────────────────────────────────────────────
-- "itemCode" is deliberately NOT unique yet: dishes are keyed per branch, so
-- the same drink sold at two stations is two rows today, and whether those
-- share one RRA code or take two is still an open decision. The constraint gets
-- added once that is settled — adding one later is a migration, removing a
-- wrong one is a data cleanup.
ALTER TABLE "dishes" ADD COLUMN IF NOT EXISTS "itemCode" TEXT;
ALTER TABLE "dishes" ADD COLUMN IF NOT EXISTS "rraClassificationCode" TEXT;
ALTER TABLE "dishes" ADD COLUMN IF NOT EXISTS "taxCategory" TEXT;
ALTER TABLE "dishes" ADD COLUMN IF NOT EXISTS "unitOfMeasure" TEXT;
ALTER TABLE "dishes" ADD COLUMN IF NOT EXISTS "packagingUnit" TEXT;

-- ── Per-line tax, snapshotted at sale time ──────────────────────────────────
-- Null on every line taken outside fiscal mode, which is every line so far.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "taxCategory" TEXT;
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "taxableAmount" DOUBLE PRECISION;
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "taxAmount" DOUBLE PRECISION;

-- ── Fiscal receipt sequences ────────────────────────────────────────────────
-- One gap-free, never-repeating counter per receipt type per outlet.
--
-- The UNIQUE constraint on (branchId, receiptType) is what makes the claim
-- atomic: it is the row the increment locks. Without it two tills could each
-- create their own counter row for the same outlet and hand out the same
-- receipt number, which is the single thing RRA audits hardest for.
CREATE TABLE IF NOT EXISTS "fiscal_counters" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "receiptType" TEXT NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "fiscal_counters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "fiscal_counters_branchId_receiptType_key" ON "fiscal_counters"("branchId", "receiptType");
CREATE INDEX IF NOT EXISTS "fiscal_counters_restaurantId_idx" ON "fiscal_counters"("restaurantId");

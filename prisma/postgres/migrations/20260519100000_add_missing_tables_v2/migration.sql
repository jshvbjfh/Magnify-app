-- Migration: add_missing_tables_v2 (idempotent rewrite — safe to re-apply after failure)
-- Neon Postgres track
--
-- What this fixes:
--   1. Rename restaurant_branches → branches  (Prisma schema maps Branch to "branches")
--   2. Create staff, staff_branches, employee_shifts  (new models, never in PG before)
--   3. Create order_items  (Prisma OrderItem maps to "order_items", not "restaurant_order_items")
--   4. Create journal_entries, journal_lines  (replaced old "transactions" model)
--   5. Add missing columns to restaurant_orders and inventory_purchases
--   6. Fix app_schema_state: drop NOT NULL on legacy columns removed from Prisma schema
--   7. Add FK constraints from existing branchId columns → branches

-- ── 1. Rename restaurant_branches → branches (idempotent) ────────────────────

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'restaurant_branches'
  ) THEN
    ALTER TABLE "restaurant_branches" DROP CONSTRAINT IF EXISTS "restaurant_branches_restaurantId_fkey";
    ALTER TABLE "restaurant_branches" RENAME TO "branches";
  END IF;
END $$;

-- Fallback: create branches if neither rename nor prior db-push created it
CREATE TABLE IF NOT EXISTS "branches" (
    "id"           TEXT        NOT NULL,
    "restaurantId" TEXT        NOT NULL,
    "name"         TEXT        NOT NULL DEFAULT 'Main Branch',
    "code"         TEXT        NOT NULL DEFAULT 'MAIN',
    "isMain"       BOOLEAN     NOT NULL DEFAULT true,
    "isActive"     BOOLEAN     NOT NULL DEFAULT true,
    "address"      TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    "deletedAt"    TIMESTAMP(3),

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- Add columns the Prisma Branch model needs that weren't in restaurant_branches
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "address"   TEXT;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

-- Re-add the outbound FK under its new name
DO $$ BEGIN
  ALTER TABLE "branches" ADD CONSTRAINT "branches_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. Add FK constraints from existing branchId columns → branches ───────────

DO $$ BEGIN
  ALTER TABLE "dishes" ADD CONSTRAINT "dishes_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "inventory_purchases" ADD CONSTRAINT "inventory_purchases_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "inventory_adjustment_logs" ADD CONSTRAINT "inventory_adjustment_logs_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "inventory_batch_usage_ledgers" ADD CONSTRAINT "inventory_batch_usage_ledgers_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "dish_sales" ADD CONSTRAINT "dish_sales_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "waste_logs" ADD CONSTRAINT "waste_logs_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "sync_outbox" ADD CONSTRAINT "sync_outbox_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. Create staff ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "staff" (
    "id"           TEXT        NOT NULL,
    "restaurantId" TEXT        NOT NULL,
    "name"         TEXT        NOT NULL,
    "role"         TEXT        NOT NULL DEFAULT 'waiter',
    "username"     TEXT,
    "password"     TEXT,
    "pin"          TEXT,
    "isActive"     BOOLEAN     NOT NULL DEFAULT true,
    "phone"        TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt"    TIMESTAMP(3),

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_restaurantId_username_key" ON "staff"("restaurantId", "username");
CREATE INDEX IF NOT EXISTS "staff_restaurantId_idx" ON "staff"("restaurantId");

DO $$ BEGIN
  ALTER TABLE "staff" ADD CONSTRAINT "staff_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 4. Create staff_branches ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "staff_branches" (
    "id"        TEXT        NOT NULL,
    "staffId"   TEXT        NOT NULL,
    "branchId"  TEXT        NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_branches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_branches_staffId_branchId_key" ON "staff_branches"("staffId", "branchId");

DO $$ BEGIN
  ALTER TABLE "staff_branches" ADD CONSTRAINT "staff_branches_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "staff_branches" ADD CONSTRAINT "staff_branches_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 5. Create employee_shifts ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "employee_shifts" (
    "id"           TEXT        NOT NULL,
    "restaurantId" TEXT        NOT NULL,
    "branchId"     TEXT        NOT NULL,
    "staffId"      TEXT        NOT NULL,
    "clockInAt"    TIMESTAMP(3) NOT NULL,
    "clockOutAt"   TIMESTAMP(3),
    "durationMins" INTEGER,
    "notes"        TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt"    TIMESTAMP(3),

    CONSTRAINT "employee_shifts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "employee_shifts_branchId_staffId_clockInAt_idx" ON "employee_shifts"("branchId", "staffId", "clockInAt");

DO $$ BEGIN
  ALTER TABLE "employee_shifts" ADD CONSTRAINT "employee_shifts_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "employee_shifts" ADD CONSTRAINT "employee_shifts_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 6. Create journal_entries ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "journal_entries" (
    "id"           TEXT        NOT NULL,
    "restaurantId" TEXT        NOT NULL,
    "branchId"     TEXT,
    "description"  TEXT,
    "reference"    TEXT,
    "entryDate"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt"    TIMESTAMP(3),

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "journal_entries_restaurantId_entryDate_idx" ON "journal_entries"("restaurantId", "entryDate");
CREATE INDEX IF NOT EXISTS "journal_entries_branchId_idx" ON "journal_entries"("branchId");

DO $$ BEGIN
  ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 7. Create journal_lines ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "journal_lines" (
    "id"             TEXT             NOT NULL,
    "journalEntryId" TEXT             NOT NULL,
    "accountId"      TEXT             NOT NULL,
    "debit"          DOUBLE PRECISION NOT NULL DEFAULT 0,
    "credit"         DOUBLE PRECISION NOT NULL DEFAULT 0,
    "description"    TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "journal_lines_journalEntryId_idx" ON "journal_lines"("journalEntryId");

DO $$ BEGIN
  ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journalEntryId_fkey"
    FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 8. Create order_items ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "order_items" (
    "id"            TEXT             NOT NULL,
    "orderId"       TEXT             NOT NULL,
    "dishId"        TEXT             NOT NULL,
    "dishName"      TEXT             NOT NULL,
    "dishPrice"     DOUBLE PRECISION NOT NULL,
    "qty"           INTEGER          NOT NULL DEFAULT 1,
    "totalPrice"    DOUBLE PRECISION NOT NULL DEFAULT 0,
    "kitchenStatus" TEXT             NOT NULL DEFAULT 'new',
    "status"        TEXT             NOT NULL DEFAULT 'ACTIVE',
    "cancelReason"  TEXT,
    "notes"         TEXT,
    "readyAt"       TIMESTAMP(3),
    "canceledAt"    TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt"     TIMESTAMP(3),

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "order_items_orderId_status_kitchenStatus_idx" ON "order_items"("orderId", "status", "kitchenStatus");

DO $$ BEGIN
  ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "restaurant_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "order_items" ADD CONSTRAINT "order_items_dishId_fkey"
    FOREIGN KEY ("dishId") REFERENCES "dishes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 9. Add missing columns to restaurant_orders ───────────────────────────────

ALTER TABLE "restaurant_orders"
  ADD COLUMN IF NOT EXISTS "staffId"        TEXT,
  ADD COLUMN IF NOT EXISTS "notes"          TEXT,
  ADD COLUMN IF NOT EXISTS "journalEntryId" TEXT,
  ADD COLUMN IF NOT EXISTS "deletedAt"      TIMESTAMP(3);

DO $$ BEGIN
  ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_journalEntryId_fkey"
    FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 10. Add missing columns to inventory_purchases ────────────────────────────

ALTER TABLE "inventory_purchases"
  ADD COLUMN IF NOT EXISTS "paymentMethod"  TEXT NOT NULL DEFAULT 'Cash',
  ADD COLUMN IF NOT EXISTS "journalEntryId" TEXT,
  ADD COLUMN IF NOT EXISTS "deletedAt"      TIMESTAMP(3);

DO $$ BEGIN
  ALTER TABLE "inventory_purchases" ADD CONSTRAINT "inventory_purchases_journalEntryId_fkey"
    FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 11. Fix app_schema_state: legacy NOT NULL columns ────────────────────────

ALTER TABLE "app_schema_state"
  ALTER COLUMN "syncProtocolVersion" DROP NOT NULL,
  ALTER COLUMN "bootstrapVersion"    DROP NOT NULL,
  ALTER COLUMN "migrationState"      DROP NOT NULL;

-- ── 12. Add staffId index on restaurant_orders ────────────────────────────────

CREATE INDEX IF NOT EXISTS "restaurant_orders_staffId_idx" ON "restaurant_orders"("staffId");

-- ── 13. Update dishes unique index to match current Prisma schema ─────────────

DROP INDEX IF EXISTS "dishes_userId_restaurantId_branchId_name_key";
DROP INDEX IF EXISTS "dishes_userId_restaurantId_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "dishes_restaurantId_branchId_name_key"
  ON "dishes"("restaurantId", "branchId", "name");

-- ── 14. Update inventory_items unique index to match Prisma schema ────────────

DROP INDEX IF EXISTS "inventory_items_userId_restaurantId_branchId_name_key";
DROP INDEX IF EXISTS "inventory_items_userId_restaurantId_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_items_restaurantId_branchId_name_key"
  ON "inventory_items"("restaurantId", "branchId", "name");

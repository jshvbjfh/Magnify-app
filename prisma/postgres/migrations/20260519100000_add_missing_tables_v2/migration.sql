-- Migration: add_missing_tables_v2 (idempotent — safe to re-apply after any failure)
-- Neon Postgres track
--
-- Handles three possible starting states:
--   A) Only restaurant_branches exists → rename to branches
--   B) Both restaurant_branches AND branches exist (db push ran) → merge + drop old
--   C) Only branches exists → already done, nothing to rename
--   D) Neither exists → CREATE TABLE IF NOT EXISTS handles it
--
-- Then backfills any rows with stale branchId values before enforcing FK constraints.

-- ── 0. Drop old unique indexes early (prevents backfill conflicts) ────────────

DROP INDEX IF EXISTS "dishes_userId_restaurantId_branchId_name_key";
DROP INDEX IF EXISTS "dishes_userId_restaurantId_name_key";
DROP INDEX IF EXISTS "inventory_items_userId_restaurantId_branchId_name_key";
DROP INDEX IF EXISTS "inventory_items_userId_restaurantId_name_key";

-- ── 1. Rename / merge restaurant_branches → branches ─────────────────────────

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'restaurant_branches'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'branches'
  ) THEN
    -- Case A: only old table exists → safe to rename
    ALTER TABLE "restaurant_branches" DROP CONSTRAINT IF EXISTS "restaurant_branches_restaurantId_fkey";
    ALTER TABLE "restaurant_branches" RENAME TO "branches";

  ELSIF EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'restaurant_branches'
  ) AND EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'branches'
  ) THEN
    -- Case B: both exist (db push created branches separately)
    -- Copy any IDs from restaurant_branches that are not yet in branches so that
    -- existing rows in dishes/orders/etc. that reference the old IDs remain valid.
    INSERT INTO "branches" (id, "restaurantId", name, code, "isMain", "isActive", "createdAt", "updatedAt")
    SELECT rb.id, rb."restaurantId", rb.name, rb.code, rb."isMain", rb."isActive", rb."createdAt", rb."updatedAt"
    FROM "restaurant_branches" rb
    WHERE NOT EXISTS (SELECT 1 FROM "branches" WHERE id = rb.id)
    ON CONFLICT DO NOTHING;

    ALTER TABLE "restaurant_branches" DROP CONSTRAINT IF EXISTS "restaurant_branches_restaurantId_fkey";
    DROP TABLE "restaurant_branches";
  END IF;
  -- Case C: only branches exists → nothing to do
  -- Case D: neither → CREATE TABLE IF NOT EXISTS below creates it
END $$;

-- Fallback: create branches if it still doesn't exist after the block above
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

ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "address"   TEXT;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

DO $$ BEGIN
  ALTER TABLE "branches" ADD CONSTRAINT "branches_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 1.5. Backfill stale branchId values before enforcing FK constraints ───────
-- Rows that reference a branchId not in branches (e.g. old 'branch_X' IDs that
-- were not merged above) are remapped to the restaurant's main/active branch.

DO $$ BEGIN
  UPDATE "dishes" SET "branchId" = b.id
  FROM (
    SELECT DISTINCT ON ("restaurantId") id, "restaurantId"
    FROM "branches"
    ORDER BY "restaurantId", "isMain" DESC, "isActive" DESC, "createdAt" ASC
  ) b
  WHERE "dishes"."restaurantId" = b."restaurantId"
    AND "dishes"."branchId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "branches" WHERE id = "dishes"."branchId");
END $$;

DO $$ BEGIN
  UPDATE "restaurant_tables" SET "branchId" = b.id
  FROM (
    SELECT DISTINCT ON ("restaurantId") id, "restaurantId"
    FROM "branches"
    ORDER BY "restaurantId", "isMain" DESC, "isActive" DESC, "createdAt" ASC
  ) b
  WHERE "restaurant_tables"."restaurantId" = b."restaurantId"
    AND "restaurant_tables"."branchId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "branches" WHERE id = "restaurant_tables"."branchId");
END $$;

DO $$ BEGIN
  UPDATE "restaurant_orders" SET "branchId" = b.id
  FROM (
    SELECT DISTINCT ON ("restaurantId") id, "restaurantId"
    FROM "branches"
    ORDER BY "restaurantId", "isMain" DESC, "isActive" DESC, "createdAt" ASC
  ) b
  WHERE "restaurant_orders"."restaurantId" = b."restaurantId"
    AND "restaurant_orders"."branchId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "branches" WHERE id = "restaurant_orders"."branchId");
END $$;

DO $$ BEGIN
  UPDATE "inventory_items" SET "branchId" = b.id
  FROM (
    SELECT DISTINCT ON ("restaurantId") id, "restaurantId"
    FROM "branches"
    ORDER BY "restaurantId", "isMain" DESC, "isActive" DESC, "createdAt" ASC
  ) b
  WHERE "inventory_items"."restaurantId" = b."restaurantId"
    AND "inventory_items"."branchId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "branches" WHERE id = "inventory_items"."branchId");
END $$;

DO $$ BEGIN
  UPDATE "inventory_purchases" SET "branchId" = b.id
  FROM (
    SELECT DISTINCT ON ("restaurantId") id, "restaurantId"
    FROM "branches"
    ORDER BY "restaurantId", "isMain" DESC, "isActive" DESC, "createdAt" ASC
  ) b
  WHERE "inventory_purchases"."restaurantId" = b."restaurantId"
    AND "inventory_purchases"."branchId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "branches" WHERE id = "inventory_purchases"."branchId");
END $$;

DO $$ BEGIN
  UPDATE "inventory_adjustment_logs" SET "branchId" = b.id
  FROM (
    SELECT DISTINCT ON ("restaurantId") id, "restaurantId"
    FROM "branches"
    ORDER BY "restaurantId", "isMain" DESC, "isActive" DESC, "createdAt" ASC
  ) b
  WHERE "inventory_adjustment_logs"."restaurantId" = b."restaurantId"
    AND "inventory_adjustment_logs"."branchId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "branches" WHERE id = "inventory_adjustment_logs"."branchId");
END $$;

DO $$ BEGIN
  UPDATE "inventory_batch_usage_ledgers" SET "branchId" = b.id
  FROM (
    SELECT DISTINCT ON ("restaurantId") id, "restaurantId"
    FROM "branches"
    ORDER BY "restaurantId", "isMain" DESC, "isActive" DESC, "createdAt" ASC
  ) b
  WHERE "inventory_batch_usage_ledgers"."restaurantId" = b."restaurantId"
    AND "inventory_batch_usage_ledgers"."branchId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "branches" WHERE id = "inventory_batch_usage_ledgers"."branchId");
END $$;

DO $$ BEGIN
  UPDATE "dish_sales" SET "branchId" = b.id
  FROM (
    SELECT DISTINCT ON ("restaurantId") id, "restaurantId"
    FROM "branches"
    ORDER BY "restaurantId", "isMain" DESC, "isActive" DESC, "createdAt" ASC
  ) b
  WHERE "dish_sales"."restaurantId" = b."restaurantId"
    AND "dish_sales"."branchId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "branches" WHERE id = "dish_sales"."branchId");
END $$;

DO $$ BEGIN
  UPDATE "waste_logs" SET "branchId" = b.id
  FROM (
    SELECT DISTINCT ON ("restaurantId") id, "restaurantId"
    FROM "branches"
    ORDER BY "restaurantId", "isMain" DESC, "isActive" DESC, "createdAt" ASC
  ) b
  WHERE "waste_logs"."restaurantId" = b."restaurantId"
    AND "waste_logs"."branchId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "branches" WHERE id = "waste_logs"."branchId");
END $$;

-- sync tables: NULL out invalid branchIds (cursor/event records, safe to re-point)
UPDATE "sync_cursors"
SET "branchId" = NULL
WHERE "branchId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "branches" WHERE id = "sync_cursors"."branchId");

UPDATE "sync_outbox"
SET "branchId" = NULL
WHERE "branchId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "branches" WHERE id = "sync_outbox"."branchId");

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

-- ── 13. Recreate dishes unique index without userId ───────────────────────────
-- (DROP already done in step 0 to avoid conflicts during backfill)

CREATE UNIQUE INDEX IF NOT EXISTS "dishes_restaurantId_branchId_name_key"
  ON "dishes"("restaurantId", "branchId", "name");

-- ── 14. Recreate inventory_items unique index without userId ──────────────────
-- (DROP already done in step 0 to avoid conflicts during backfill)

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_items_restaurantId_branchId_name_key"
  ON "inventory_items"("restaurantId", "branchId", "name");

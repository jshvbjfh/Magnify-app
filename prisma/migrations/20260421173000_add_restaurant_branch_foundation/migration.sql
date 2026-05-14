CREATE TABLE "restaurant_branches" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"restaurantId" TEXT NOT NULL,
	"name" TEXT NOT NULL,
	"code" TEXT NOT NULL,
	"isMain" BOOLEAN NOT NULL DEFAULT false,
	"isActive" BOOLEAN NOT NULL DEFAULT true,
	"sortOrder" INTEGER NOT NULL DEFAULT 0,
	"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updatedAt" DATETIME NOT NULL,
	CONSTRAINT "restaurant_branches_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "users" ADD COLUMN "branchId" TEXT;
ALTER TABLE "restaurant_tables" ADD COLUMN "branchId" TEXT;
ALTER TABLE "restaurant_orders" ADD COLUMN "branchId" TEXT;
ALTER TABLE "pending_orders" ADD COLUMN "branchId" TEXT;
ALTER TABLE "restaurant_actions" ADD COLUMN "branchId" TEXT;
ALTER TABLE "branch_devices" ADD COLUMN "branchId" TEXT;
ALTER TABLE "sync_outbox" ADD COLUMN "branchId" TEXT;
ALTER TABLE "sync_cursors" ADD COLUMN "branchId" TEXT;
ALTER TABLE "sync_conflict_logs" ADD COLUMN "branchId" TEXT;
ALTER TABLE "transactions" ADD COLUMN "branchId" TEXT;
ALTER TABLE "daily_summaries" ADD COLUMN "branchId" TEXT;
ALTER TABLE "inventory_items" ADD COLUMN "branchId" TEXT;
ALTER TABLE "dishes" ADD COLUMN "branchId" TEXT;
ALTER TABLE "dish_sales" ADD COLUMN "branchId" TEXT;
ALTER TABLE "waste_logs" ADD COLUMN "branchId" TEXT;
ALTER TABLE "inventory_purchases" ADD COLUMN "branchId" TEXT;
ALTER TABLE "inventory_batch_usage_ledgers" ADD COLUMN "branchId" TEXT;
ALTER TABLE "inventory_adjustment_logs" ADD COLUMN "branchId" TEXT;
ALTER TABLE "employees" ADD COLUMN "branchId" TEXT;
ALTER TABLE "shifts" ADD COLUMN "branchId" TEXT;

INSERT INTO "restaurant_branches" (
	"id",
	"restaurantId",
	"name",
	"code",
	"isMain",
	"isActive",
	"sortOrder",
	"createdAt",
	"updatedAt"
)
SELECT
	'branch_' || r."id",
	r."id",
	'Main',
	'MAIN',
	1,
	1,
	0,
	CURRENT_TIMESTAMP,
	CURRENT_TIMESTAMP
FROM "restaurants" r;

UPDATE "users"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "users"
SET "branchId" = (
	SELECT 'branch_' || r."id"
	FROM "restaurants" r
	WHERE r."ownerId" = "users"."id"
		AND (SELECT COUNT(*) FROM "restaurants" rx WHERE rx."ownerId" = "users"."id") = 1
	LIMIT 1
)
WHERE "branchId" IS NULL;

UPDATE "restaurant_tables"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "restaurant_orders"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "pending_orders"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "restaurant_actions"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "branch_devices"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "sync_outbox"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "sync_cursors"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "sync_conflict_logs"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "transactions"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "daily_summaries"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "inventory_items"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "dishes"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "dish_sales"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "waste_logs"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "inventory_purchases"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "inventory_batch_usage_ledgers"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "inventory_adjustment_logs"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "employees"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

UPDATE "shifts"
SET "branchId" = 'branch_' || "restaurantId"
WHERE "branchId" IS NULL
	AND "restaurantId" IS NOT NULL;

DROP INDEX IF EXISTS "restaurant_orders_restaurantId_orderNumber_key";
DROP INDEX IF EXISTS "restaurant_orders_restaurantId_status_createdAt_idx";
DROP INDEX IF EXISTS "restaurant_actions_restaurantId_actionKey_key";
DROP INDEX IF EXISTS "restaurant_actions_restaurantId_actionType_createdAt_idx";
DROP INDEX IF EXISTS "daily_summaries_userId_restaurantId_date_key";
DROP INDEX IF EXISTS "inventory_items_userId_restaurantId_name_key";
DROP INDEX IF EXISTS "dishes_userId_restaurantId_name_key";
DROP INDEX IF EXISTS "dishes_restaurantId_isActive_idx";
DROP INDEX IF EXISTS "employees_restaurantId_isActive_idx";

CREATE UNIQUE INDEX "restaurant_branches_restaurantId_name_key" ON "restaurant_branches"("restaurantId", "name");
CREATE UNIQUE INDEX "restaurant_branches_restaurantId_code_key" ON "restaurant_branches"("restaurantId", "code");
CREATE INDEX "restaurant_branches_restaurantId_isActive_sortOrder_idx" ON "restaurant_branches"("restaurantId", "isActive", "sortOrder");
CREATE INDEX "users_branchId_idx" ON "users"("branchId");
CREATE INDEX "restaurant_tables_branchId_idx" ON "restaurant_tables"("branchId");
CREATE INDEX "restaurant_orders_branchId_idx" ON "restaurant_orders"("branchId");
CREATE UNIQUE INDEX "restaurant_orders_restaurantId_branchId_orderNumber_key" ON "restaurant_orders"("restaurantId", "branchId", "orderNumber");
CREATE INDEX "restaurant_orders_restaurantId_branchId_status_createdAt_idx" ON "restaurant_orders"("restaurantId", "branchId", "status", "createdAt");
CREATE INDEX "pending_orders_branchId_idx" ON "pending_orders"("branchId");
CREATE INDEX "restaurant_actions_branchId_idx" ON "restaurant_actions"("branchId");
CREATE UNIQUE INDEX "restaurant_actions_restaurantId_branchId_actionKey_key" ON "restaurant_actions"("restaurantId", "branchId", "actionKey");
CREATE INDEX "restaurant_actions_restaurantId_branchId_actionType_createdAt_idx" ON "restaurant_actions"("restaurantId", "branchId", "actionType", "createdAt");
CREATE INDEX "branch_devices_branchId_idx" ON "branch_devices"("branchId");
CREATE INDEX "sync_outbox_branchId_idx" ON "sync_outbox"("branchId");
CREATE INDEX "sync_cursors_branchId_idx" ON "sync_cursors"("branchId");
CREATE INDEX "sync_conflict_logs_branchId_idx" ON "sync_conflict_logs"("branchId");
CREATE INDEX "transactions_branchId_idx" ON "transactions"("branchId");
CREATE INDEX "daily_summaries_branchId_idx" ON "daily_summaries"("branchId");
CREATE UNIQUE INDEX "daily_summaries_userId_restaurantId_branchId_date_key" ON "daily_summaries"("userId", "restaurantId", "branchId", "date");
CREATE INDEX "inventory_items_branchId_idx" ON "inventory_items"("branchId");
CREATE UNIQUE INDEX "inventory_items_userId_restaurantId_branchId_name_key" ON "inventory_items"("userId", "restaurantId", "branchId", "name");
CREATE INDEX "dishes_branchId_idx" ON "dishes"("branchId");
CREATE UNIQUE INDEX "dishes_userId_restaurantId_branchId_name_key" ON "dishes"("userId", "restaurantId", "branchId", "name");
CREATE INDEX "dishes_restaurantId_branchId_isActive_idx" ON "dishes"("restaurantId", "branchId", "isActive");
CREATE INDEX "dish_sales_branchId_idx" ON "dish_sales"("branchId");
CREATE INDEX "waste_logs_branchId_idx" ON "waste_logs"("branchId");
CREATE INDEX "inventory_purchases_branchId_idx" ON "inventory_purchases"("branchId");
CREATE INDEX "inventory_batch_usage_ledgers_branchId_idx" ON "inventory_batch_usage_ledgers"("branchId");
CREATE INDEX "inventory_adjustment_logs_branchId_idx" ON "inventory_adjustment_logs"("branchId");
CREATE INDEX "employees_branchId_idx" ON "employees"("branchId");
CREATE INDEX "employees_restaurantId_branchId_isActive_idx" ON "employees"("restaurantId", "branchId", "isActive");
CREATE INDEX "shifts_branchId_idx" ON "shifts"("branchId");
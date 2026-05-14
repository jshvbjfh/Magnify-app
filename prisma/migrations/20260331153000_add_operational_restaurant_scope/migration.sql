ALTER TABLE "inventory_items" ADD COLUMN "restaurantId" TEXT;
ALTER TABLE "dish_sales" ADD COLUMN "restaurantId" TEXT;
ALTER TABLE "waste_logs" ADD COLUMN "restaurantId" TEXT;
ALTER TABLE "inventory_purchases" ADD COLUMN "restaurantId" TEXT;
ALTER TABLE "shifts" ADD COLUMN "restaurantId" TEXT;

-- Backfill rows only when restaurant ownership can be inferred safely.
UPDATE "inventory_items"
SET "restaurantId" = COALESCE(
  (
    SELECT u."restaurantId"
    FROM "users" u
    WHERE u."id" = "inventory_items"."userId"
      AND u."restaurantId" IS NOT NULL
  ),
  (
    SELECT r."id"
    FROM "restaurants" r
    WHERE r."ownerId" = "inventory_items"."userId"
      AND (SELECT COUNT(*) FROM "restaurants" rx WHERE rx."ownerId" = "inventory_items"."userId") = 1
    LIMIT 1
  )
)
WHERE "restaurantId" IS NULL;

UPDATE "dish_sales"
SET "restaurantId" = COALESCE(
  (
    SELECT u."restaurantId"
    FROM "users" u
    WHERE u."id" = "dish_sales"."userId"
      AND u."restaurantId" IS NOT NULL
  ),
  (
    SELECT r."id"
    FROM "restaurants" r
    WHERE r."ownerId" = "dish_sales"."userId"
      AND (SELECT COUNT(*) FROM "restaurants" rx WHERE rx."ownerId" = "dish_sales"."userId") = 1
    LIMIT 1
  )
)
WHERE "restaurantId" IS NULL;

UPDATE "waste_logs"
SET "restaurantId" = COALESCE(
  (
    SELECT u."restaurantId"
    FROM "users" u
    WHERE u."id" = "waste_logs"."userId"
      AND u."restaurantId" IS NOT NULL
  ),
  (
    SELECT r."id"
    FROM "restaurants" r
    WHERE r."ownerId" = "waste_logs"."userId"
      AND (SELECT COUNT(*) FROM "restaurants" rx WHERE rx."ownerId" = "waste_logs"."userId") = 1
    LIMIT 1
  )
)
WHERE "restaurantId" IS NULL;

UPDATE "waste_logs"
SET "restaurantId" = (
  SELECT ii."restaurantId"
  FROM "inventory_items" ii
  WHERE ii."id" = "waste_logs"."ingredientId"
    AND ii."restaurantId" IS NOT NULL
)
WHERE "restaurantId" IS NULL;

UPDATE "inventory_purchases"
SET "restaurantId" = COALESCE(
  (
    SELECT u."restaurantId"
    FROM "users" u
    WHERE u."id" = "inventory_purchases"."userId"
      AND u."restaurantId" IS NOT NULL
  ),
  (
    SELECT r."id"
    FROM "restaurants" r
    WHERE r."ownerId" = "inventory_purchases"."userId"
      AND (SELECT COUNT(*) FROM "restaurants" rx WHERE rx."ownerId" = "inventory_purchases"."userId") = 1
    LIMIT 1
  )
)
WHERE "restaurantId" IS NULL;

UPDATE "inventory_purchases"
SET "restaurantId" = (
  SELECT ii."restaurantId"
  FROM "inventory_items" ii
  WHERE ii."id" = "inventory_purchases"."ingredientId"
    AND ii."restaurantId" IS NOT NULL
)
WHERE "restaurantId" IS NULL;

UPDATE "shifts"
SET "restaurantId" = COALESCE(
  (
    SELECT u."restaurantId"
    FROM "users" u
    WHERE u."id" = "shifts"."userId"
      AND u."restaurantId" IS NOT NULL
  ),
  (
    SELECT r."id"
    FROM "restaurants" r
    WHERE r."ownerId" = "shifts"."userId"
      AND (SELECT COUNT(*) FROM "restaurants" rx WHERE rx."ownerId" = "shifts"."userId") = 1
    LIMIT 1
  )
)
WHERE "restaurantId" IS NULL;

CREATE INDEX "inventory_items_restaurantId_idx" ON "inventory_items"("restaurantId");
CREATE INDEX "dish_sales_restaurantId_idx" ON "dish_sales"("restaurantId");
CREATE INDEX "waste_logs_restaurantId_idx" ON "waste_logs"("restaurantId");
CREATE INDEX "inventory_purchases_restaurantId_idx" ON "inventory_purchases"("restaurantId");
CREATE INDEX "shifts_restaurantId_idx" ON "shifts"("restaurantId");

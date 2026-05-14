ALTER TABLE "inventory_items"
ADD COLUMN "purchaseUnit" TEXT,
ADD COLUMN "unitsPerPurchaseUnit" DOUBLE PRECISION;

UPDATE "inventory_items"
SET "purchaseUnit" = COALESCE("purchaseUnit", "unit"),
    "unitsPerPurchaseUnit" = COALESCE("unitsPerPurchaseUnit", 1)
WHERE "purchaseUnit" IS NULL
   OR "unitsPerPurchaseUnit" IS NULL;

ALTER TABLE "inventory_purchases"
ADD COLUMN "purchaseQuantity" DOUBLE PRECISION,
ADD COLUMN "purchaseUnit" TEXT,
ADD COLUMN "unitsPerPurchaseUnit" DOUBLE PRECISION,
ADD COLUMN "purchaseUnitCost" DOUBLE PRECISION;

UPDATE "inventory_purchases" p
SET "purchaseQuantity" = COALESCE(p."purchaseQuantity", p."quantityPurchased"),
    "purchaseUnit" = COALESCE(p."purchaseUnit", i."purchaseUnit", i."unit"),
    "unitsPerPurchaseUnit" = COALESCE(p."unitsPerPurchaseUnit", 1),
    "purchaseUnitCost" = COALESCE(p."purchaseUnitCost", p."unitCost")
FROM "inventory_items" i
WHERE i."id" = p."ingredientId"
  AND (
    p."purchaseQuantity" IS NULL
    OR p."purchaseUnit" IS NULL
    OR p."unitsPerPurchaseUnit" IS NULL
    OR p."purchaseUnitCost" IS NULL
  );
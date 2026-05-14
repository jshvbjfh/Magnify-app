ALTER TABLE "inventory_items" ADD COLUMN "purchaseUnit" TEXT;
ALTER TABLE "inventory_items" ADD COLUMN "unitsPerPurchaseUnit" REAL;

UPDATE "inventory_items"
SET "purchaseUnit" = COALESCE("purchaseUnit", "unit"),
    "unitsPerPurchaseUnit" = COALESCE("unitsPerPurchaseUnit", 1)
WHERE "purchaseUnit" IS NULL
   OR "unitsPerPurchaseUnit" IS NULL;

ALTER TABLE "inventory_purchases" ADD COLUMN "purchaseQuantity" REAL;
ALTER TABLE "inventory_purchases" ADD COLUMN "purchaseUnit" TEXT;
ALTER TABLE "inventory_purchases" ADD COLUMN "unitsPerPurchaseUnit" REAL;
ALTER TABLE "inventory_purchases" ADD COLUMN "purchaseUnitCost" REAL;

UPDATE "inventory_purchases"
SET "purchaseQuantity" = COALESCE("purchaseQuantity", "quantityPurchased"),
    "purchaseUnit" = COALESCE(
      "purchaseUnit",
      (
        SELECT COALESCE(i."purchaseUnit", i."unit")
        FROM "inventory_items" i
        WHERE i."id" = "inventory_purchases"."ingredientId"
      )
    ),
    "unitsPerPurchaseUnit" = COALESCE("unitsPerPurchaseUnit", 1),
    "purchaseUnitCost" = COALESCE("purchaseUnitCost", "unitCost")
WHERE "purchaseQuantity" IS NULL
   OR "purchaseUnit" IS NULL
   OR "unitsPerPurchaseUnit" IS NULL
   OR "purchaseUnitCost" IS NULL;
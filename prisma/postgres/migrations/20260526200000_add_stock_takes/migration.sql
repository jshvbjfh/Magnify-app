CREATE TABLE IF NOT EXISTS "stock_takes" (
    "id"           TEXT         NOT NULL,
    "restaurantId" TEXT         NOT NULL,
    "branchId"     TEXT         NOT NULL,
    "ingredientId" TEXT         NOT NULL,
    "quantity"     DOUBLE PRECISION NOT NULL,
    "takenAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes"        TEXT,
    "recordedBy"   TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_takes_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_ingredientId_fkey"
    FOREIGN KEY ("ingredientId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "stock_takes_branchId_idx" ON "stock_takes"("branchId");
CREATE INDEX IF NOT EXISTS "stock_takes_ingredientId_takenAt_idx" ON "stock_takes"("ingredientId", "takenAt");

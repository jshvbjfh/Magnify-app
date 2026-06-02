CREATE TABLE IF NOT EXISTS "credit_sales" (
    "id"            TEXT             NOT NULL,
    "restaurantId"  TEXT             NOT NULL,
    "branchId"      TEXT,
    "customerName"  TEXT             NOT NULL,
    "customerPhone" TEXT,
    "description"   TEXT             NOT NULL,
    "amount"        DOUBLE PRECISION NOT NULL,
    "saleDate"      TIMESTAMP(3)     NOT NULL,
    "paidAt"        TIMESTAMP(3),
    "paymentMethod" TEXT,
    "createdAt"     TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "credit_sales_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "supplier_debts" (
    "id"            TEXT             NOT NULL,
    "restaurantId"  TEXT             NOT NULL,
    "branchId"      TEXT,
    "supplierName"  TEXT             NOT NULL,
    "supplierPhone" TEXT,
    "description"   TEXT             NOT NULL,
    "amount"        DOUBLE PRECISION NOT NULL,
    "purchaseDate"  TIMESTAMP(3)     NOT NULL,
    "paidAt"        TIMESTAMP(3),
    "paymentMethod" TEXT,
    "createdAt"     TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "supplier_debts_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "credit_sales" ADD CONSTRAINT "credit_sales_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "supplier_debts" ADD CONSTRAINT "supplier_debts_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "credit_sales_restaurantId_paidAt_idx" ON "credit_sales"("restaurantId", "paidAt");
CREATE INDEX IF NOT EXISTS "credit_sales_restaurantId_customerName_idx" ON "credit_sales"("restaurantId", "customerName");
CREATE INDEX IF NOT EXISTS "supplier_debts_restaurantId_paidAt_idx" ON "supplier_debts"("restaurantId", "paidAt");
CREATE INDEX IF NOT EXISTS "supplier_debts_restaurantId_supplierName_idx" ON "supplier_debts"("restaurantId", "supplierName");

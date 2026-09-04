-- The permanent record of every fiscal receipt issued.
--
-- Read by the Z and X daily reports (§18), which must reconcile with the
-- receipts they summarise. Every declared figure is stored rather than derived
-- later: the VSDC's signature covers the amounts that were sent, so recomputing
-- them after a rounding rule or tax bracket moves could produce a number that
-- no longer matches the paper in a guest's hand.
--
-- Additive and idempotent. Nothing reads this table on a non-fiscal build.

CREATE TABLE IF NOT EXISTS "fiscal_receipts" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    -- Null for a receipt with no order behind it: a training ticket, or a
    -- report-only entry.
    "orderId" TEXT,

    "receiptType" TEXT NOT NULL,
    "invoiceNumber" INTEGER NOT NULL,
    "originalInvoiceNumber" INTEGER,

    -- Returned by the VSDC. All nullable: training and proforma tickets are
    -- never signed (§6.3.6), and a queued receipt has not been answered yet.
    "sdcId" TEXT,
    "sdcDateTime" TIMESTAMP(3),
    "receiptNumberForType" INTEGER,
    "receiptNumberTotal" INTEGER,
    "internalData" TEXT,
    "receiptSignature" TEXT,

    -- What was declared.
    "paymentTypeCode" TEXT,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "totalTaxableAmount" DOUBLE PRECISION NOT NULL,
    "totalTaxAmount" DOUBLE PRECISION NOT NULL,
    "taxableAmtA" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxableAmtB" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxableAmtC" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxableAmtD" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAmtA" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAmtB" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAmtC" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAmtD" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "discountTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,

    -- PENDING until the VSDC answers, SENT once it has, FAILED when refused.
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,

    "businessDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_receipts_pkey" PRIMARY KEY ("id")
);

-- Our invoice number must never repeat within an outlet.
CREATE UNIQUE INDEX IF NOT EXISTS "fiscal_receipts_branchId_invoiceNumber_key"
    ON "fiscal_receipts"("branchId", "invoiceNumber");

-- Deliberately NOT unique. §7.17 allows an original to be reversed only once,
-- but a COPY also references the invoice it copies and §7.18 places no limit on
-- reprints — a unique index here would silently cap copies at one. The
-- refund-once rule is enforced in code, inside the settlement transaction.
CREATE INDEX IF NOT EXISTS "fiscal_receipts_branchId_originalInvoiceNumber_idx"
    ON "fiscal_receipts"("branchId", "originalInvoiceNumber");

CREATE INDEX IF NOT EXISTS "fiscal_receipts_restaurantId_businessDate_idx"
    ON "fiscal_receipts"("restaurantId", "businessDate");
CREATE INDEX IF NOT EXISTS "fiscal_receipts_branchId_businessDate_receiptType_idx"
    ON "fiscal_receipts"("branchId", "businessDate", "receiptType");
CREATE INDEX IF NOT EXISTS "fiscal_receipts_status_idx"
    ON "fiscal_receipts"("status");

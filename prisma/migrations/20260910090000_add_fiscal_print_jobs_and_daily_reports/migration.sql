-- Two things the fiscal work could not remember (§7.28 and §7.6).
--
-- fiscal_print_jobs — a receipt half-printed when the paper ran out is a
-- compliance problem, not a stationery one: the guest has no receipt, and §7.18
-- permits exactly ONE original per sale. The recovery logic already exists in
-- lib/fiscalPrintRecovery, but nothing remembered a print was in progress, so a
-- till that lost power came back knowing nothing. "originalCompleted" is the
-- field that matters — if the guest already has their paper, anything further
-- prints as a COPY, and storing that rather than deriving it means a crash
-- between printing and confirming cannot produce a second original.
--
-- fiscal_daily_reports — §7.6 defines the X report as covering everything since
-- the last Z, NOT since the last X. With nothing recording when a Z was taken,
-- the X window was opening at the business date instead: the same answer only
-- in a venue that never skips a day. Only Z is recorded; an X closes nothing
-- and may be taken repeatedly, so recording one would corrupt the very window
-- it is measured from.
--
-- Figures are stored as declared rather than recomputed later, for the same
-- reason fiscal_receipts stores its own: a Z closes a day, and reprinting it
-- next year must reproduce the numbers that were declared, not the numbers a
-- later rounding rule would produce.
--
-- Additive throughout; nothing reads either table on a non-fiscal build.
-- (SQLite: dev + Electron local-first.)

CREATE TABLE "fiscal_print_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    -- Null for a proforma or training ticket, which are not fiscal receipts.
    "fiscalReceiptId" TEXT,

    -- PENDING | PRINTING | INTERRUPTED | COMPLETED
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "totalLines" INTEGER NOT NULL DEFAULT 0,
    -- Lines the printer confirmed, so an interrupted job resumes in the right
    -- place instead of starting again.
    "linesPrinted" INTEGER NOT NULL DEFAULT 0,
    -- Whether an original has ever finished for this receipt (§7.18).
    "originalCompleted" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,

    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- The recovery query on startup: is anything interrupted at this outlet.
CREATE INDEX "fiscal_print_jobs_branchId_state_idx"
    ON "fiscal_print_jobs"("branchId", "state");
CREATE INDEX "fiscal_print_jobs_fiscalReceiptId_idx"
    ON "fiscal_print_jobs"("fiscalReceiptId");

CREATE TABLE "fiscal_daily_reports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,

    -- Only 'Z' is ever recorded here.
    "kind" TEXT NOT NULL DEFAULT 'Z',
    "businessDate" DATETIME NOT NULL,
    -- The window actually covered, so the next X opens where this one ended
    -- rather than at a date boundary that may not match it.
    "coveredFrom" DATETIME NOT NULL,
    "coveredTo" DATETIME NOT NULL,

    "takenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "takenByName" TEXT,

    "salesCount" INTEGER NOT NULL DEFAULT 0,
    "salesTotal" REAL NOT NULL DEFAULT 0,
    "refundCount" INTEGER NOT NULL DEFAULT 0,
    "refundTotal" REAL NOT NULL DEFAULT 0,
    "totalTax" REAL NOT NULL DEFAULT 0
);

-- A day is closed once. A second Z for the same trading day is refused rather
-- than allowed to reopen and re-summarise a day already declared.
CREATE UNIQUE INDEX "fiscal_daily_reports_branchId_kind_businessDate_key"
    ON "fiscal_daily_reports"("branchId", "kind", "businessDate");
CREATE INDEX "fiscal_daily_reports_branchId_takenAt_idx"
    ON "fiscal_daily_reports"("branchId", "takenAt");

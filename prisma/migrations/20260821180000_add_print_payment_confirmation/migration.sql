-- Print a payment-confirmation slip automatically whenever a bill is settled:
-- the same bill the guest already got, plus the tender it was paid with.
-- (SQLite: dev + Electron local-first.)
--
-- Defaults to false so no venue starts printing a second slip per table until a
-- manager asks for it. Plain ADD COLUMN: SQLite has no IF NOT EXISTS on ALTER,
-- and the migration ledger is what stops this running twice.
ALTER TABLE "restaurants" ADD COLUMN "printPaymentConfirmation" BOOLEAN NOT NULL DEFAULT false;

-- Print a payment-confirmation slip automatically whenever a bill is settled:
-- the same bill the guest already got, plus the tender it was paid with.
--
-- Defaults to false so no venue starts printing a second slip per table until a
-- manager asks for it. Additive and idempotent.
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "printPaymentConfirmation" BOOLEAN NOT NULL DEFAULT false;

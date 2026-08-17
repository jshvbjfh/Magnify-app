-- Whether the venue runs service shifts. ON by default so no existing
-- restaurant changes behaviour: shifts keep gating the waiter app and stamping
-- orders exactly as before. Switched off per restaurant, new orders simply
-- carry no shiftId/businessDate and reports fall back to paidAt — the columns
-- were already nullable for that case. Orders already stamped are untouched.
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "shiftsEnabled" BOOLEAN NOT NULL DEFAULT true;

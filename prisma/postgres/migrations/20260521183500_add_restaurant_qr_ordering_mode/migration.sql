-- Migration: add_restaurant_qr_ordering_mode
-- Purpose: persist guest QR access mode on restaurants so signup, settings,
-- and public guest ordering all read the same source of truth.

ALTER TABLE "restaurants"
ADD COLUMN IF NOT EXISTS "qrOrderingMode" TEXT NOT NULL DEFAULT 'order';

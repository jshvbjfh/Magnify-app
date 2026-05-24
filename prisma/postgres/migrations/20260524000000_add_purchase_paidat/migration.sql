-- AlterTable: add paidAt to inventory_purchases
ALTER TABLE "inventory_purchases" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);

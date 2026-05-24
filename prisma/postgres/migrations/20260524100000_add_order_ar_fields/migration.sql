-- AlterTable: add A/R tracking fields to restaurant_orders
ALTER TABLE "restaurant_orders" ADD COLUMN IF NOT EXISTS "arCustomerName" TEXT;
ALTER TABLE "restaurant_orders" ADD COLUMN IF NOT EXISTS "arCollectedAt" TIMESTAMP(3);

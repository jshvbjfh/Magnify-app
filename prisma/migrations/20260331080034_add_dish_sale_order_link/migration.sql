-- AlterTable
ALTER TABLE "dish_sales" ADD COLUMN "orderId" TEXT;

-- CreateIndex
CREATE INDEX "dish_sales_orderId_idx" ON "dish_sales"("orderId");

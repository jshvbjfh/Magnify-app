ALTER TABLE "inventory_purchases"
ADD COLUMN "journalPairId" TEXT;

CREATE INDEX "inventory_purchases_journalPairId_idx"
ON "inventory_purchases"("journalPairId");
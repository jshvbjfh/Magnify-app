CREATE TABLE "stock_takes" (
    "id"           TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "branchId"     TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "quantity"     REAL NOT NULL,
    "takenAt"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes"        TEXT,
    "recordedBy"   TEXT,
    "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_takes_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "stock_takes_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "inventory_items" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "stock_takes_branchId_idx" ON "stock_takes"("branchId");
CREATE INDEX "stock_takes_ingredientId_takenAt_idx" ON "stock_takes"("ingredientId", "takenAt");

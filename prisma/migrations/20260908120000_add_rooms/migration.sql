-- Rooms: a light room list for the hotels adopting Magnify.
--
-- A room LIST, not a property management system. No reservations, no rate
-- calendar, no night audit. These venues already run their restaurant here and
-- want the rooms beside the floor plan, not a second system to learn.
--
-- Shaped after restaurant_tables because a room behaves like a table let by the
-- night, and scoped the same way: unique on (restaurantId, name), with branchId
-- kept only as origin metadata. A hotel's kitchen, bar and reception are
-- stations of one property and every one of them must see the same rooms.
--
-- Additive throughout: no existing table is touched except the restaurants
-- flag, which defaults off, so no venue sees any change until a manager asks.
-- (SQLite: dev + Electron local-first.)
ALTER TABLE "restaurants" ADD COLUMN "hotelEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "rooms" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'double',
    "capacity" INTEGER NOT NULL DEFAULT 2,
    "rate" REAL NOT NULL DEFAULT 0,
    -- vacant · occupied · dirty · maintenance. "dirty" is its own state on
    -- purpose: a room the guest just left is neither sellable nor occupied.
    "status" TEXT NOT NULL DEFAULT 'vacant',
    "floor" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "rooms_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "rooms_restaurantId_name_key" ON "rooms"("restaurantId", "name");
CREATE INDEX "rooms_restaurantId_branchId_idx" ON "rooms"("restaurantId", "branchId");

-- One stock for the whole restaurant, held by the main station, instead of every
-- station keeping its own. Off by default so no existing restaurant changes
-- behaviour: it is switched on per restaurant, and switching it back off
-- restores per-station stock without touching any data.
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "sharedStock" BOOLEAN NOT NULL DEFAULT false;

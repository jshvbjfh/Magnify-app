-- Add managerId to restaurants so admin (manager) can be resolved separately from ownerId (investor)
ALTER TABLE "restaurants" ADD COLUMN "managerId" TEXT;

CREATE INDEX "restaurants_managerId_idx" ON "restaurants"("managerId");

ALTER TABLE "restaurants"
  ADD CONSTRAINT "restaurants_managerId_fkey"
  FOREIGN KEY ("managerId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: set managerId = ownerId for existing rows where ownerId maps to an admin-role user
UPDATE "restaurants" r
SET "managerId" = r."ownerId"
WHERE EXISTS (
  SELECT 1 FROM "users" u WHERE u.id = r."ownerId" AND u.role = 'admin'
);

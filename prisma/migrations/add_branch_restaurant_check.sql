-- ==========================================================================
-- Phase 3: Database-level safety net for branchId ↔ restaurantId consistency
--
-- Creates a PostgreSQL trigger that fires BEFORE INSERT or UPDATE on the
-- `users` table. When a user row has both `branchId` and `restaurantId` set,
-- the trigger validates that the branch actually belongs to that restaurant.
-- If not, it raises an exception and blocks the write.
--
-- This is the last line of defense after the application-level guards in
-- restaurantAccess.ts (Phase 1) and the write-path fixes (Phase 2).
--
-- NOTE: SQLite (local POS) does not support triggers the same way, so this
-- constraint only applies to the Neon/Postgres side. The application-level
-- validation covers both environments.
-- ==========================================================================

-- Drop the trigger and function if they already exist (idempotent re-runs)
DROP TRIGGER IF EXISTS trg_user_branch_restaurant_check ON users;
DROP FUNCTION IF EXISTS fn_user_branch_restaurant_check();

CREATE OR REPLACE FUNCTION fn_user_branch_restaurant_check()
RETURNS TRIGGER AS $$
BEGIN
  -- Only validate when BOTH branchId and restaurantId are non-null.
  -- If either is null, the application-level self-healing will resolve it
  -- on the next request via getRestaurantContextForUser.
  IF NEW."branchId" IS NOT NULL AND NEW."restaurantId" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM restaurant_branches rb
      WHERE rb.id = NEW."branchId"
        AND rb."restaurantId" = NEW."restaurantId"
    ) THEN
      RAISE EXCEPTION
        'branchId % does not belong to restaurantId %. '
        'User row (id=%) would create a cross-restaurant mismatch.',
        NEW."branchId", NEW."restaurantId", NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_branch_restaurant_check
  BEFORE INSERT OR UPDATE OF "branchId", "restaurantId"
  ON users
  FOR EACH ROW
  EXECUTE FUNCTION fn_user_branch_restaurant_check();

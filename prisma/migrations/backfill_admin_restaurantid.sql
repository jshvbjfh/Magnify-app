-- Verify: count admin/owner users still with null restaurantId (should be 0)
SELECT
  u.id,
  u.email,
  u.role,
  u."restaurantId",
  u."branchId"
FROM users u
WHERE u."restaurantId" IS NULL
  AND u.role IN ('admin', 'owner');

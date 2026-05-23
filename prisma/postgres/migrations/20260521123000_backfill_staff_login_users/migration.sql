-- Migration: backfill_staff_login_users
-- Purpose: hosted waiter and kitchen accounts authenticate through NextAuth's
-- users table, so legacy staff-only accounts need matching login rows.

INSERT INTO "users" (
  "id",
  "email",
  "name",
  "password",
  "role",
  "trackingMode",
  "fifoEnabled",
  "isActive",
  "isSuperAdmin",
  "createdAt",
  "updatedAt"
)
SELECT
  s."id",
  LOWER(TRIM(s."username")),
  s."name",
  s."password",
  s."role",
  'simple',
  false,
  s."isActive",
  false,
  COALESCE(s."createdAt", CURRENT_TIMESTAMP),
  COALESCE(s."updatedAt", CURRENT_TIMESTAMP)
FROM "staff" s
WHERE s."deletedAt" IS NULL
  AND s."role" IN ('waiter', 'kitchen')
  AND s."username" IS NOT NULL
  AND LENGTH(TRIM(s."username")) > 0
  AND s."password" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "users" u
    WHERE LOWER(TRIM(u."email")) = LOWER(TRIM(s."username"))
      AND u."id" <> s."id"
  )
ON CONFLICT ("id") DO UPDATE
SET
  "email" = EXCLUDED."email",
  "name" = EXCLUDED."name",
  "password" = EXCLUDED."password",
  "role" = EXCLUDED."role",
  "isActive" = EXCLUDED."isActive",
  "updatedAt" = EXCLUDED."updatedAt";
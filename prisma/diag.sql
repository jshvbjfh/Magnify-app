SELECT 
  (SELECT COUNT(*) FROM "dishes" WHERE "branchId" IS NULL) AS dish_nulls,
  (SELECT COUNT(*) FROM "dishes" WHERE "branchId" IS NULL AND "restaurantId" IS NULL) AS dish_no_restaurant,
  (SELECT COUNT(*) FROM "restaurant_tables" WHERE "branchId" IS NULL) AS table_nulls,
  (SELECT COUNT(*) FROM "restaurant_tables" WHERE "branchId" IS NULL AND "restaurantId" IS NULL) AS table_no_restaurant;

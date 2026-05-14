-- Repairs orphan branch references only for restaurants that currently have
-- exactly one active branch in Neon. This avoids ambiguous reassignment for
-- multi-branch restaurants, which require a targeted follow-up.

with single_active_branch as (
  select
    rb."restaurantId" as restaurant_id,
    min(rb.id) as branch_id
  from restaurant_branches rb
  where rb."isActive" = true
  group by rb."restaurantId"
  having count(*) = 1
)
update dishes d
set "branchId" = sab.branch_id
from single_active_branch sab
where d."restaurantId" = sab.restaurant_id
  and not exists (
    select 1
    from restaurant_branches rb
    where rb.id = d."branchId"
      and rb."restaurantId" = d."restaurantId"
  );

with single_active_branch as (
  select
    rb."restaurantId" as restaurant_id,
    min(rb.id) as branch_id
  from restaurant_branches rb
  where rb."isActive" = true
  group by rb."restaurantId"
  having count(*) = 1
)
update restaurant_tables t
set "branchId" = sab.branch_id
from single_active_branch sab
where t."restaurantId" = sab.restaurant_id
  and not exists (
    select 1
    from restaurant_branches rb
    where rb.id = t."branchId"
      and rb."restaurantId" = t."restaurantId"
  );

with single_active_branch as (
  select
    rb."restaurantId" as restaurant_id,
    min(rb.id) as branch_id
  from restaurant_branches rb
  where rb."isActive" = true
  group by rb."restaurantId"
  having count(*) = 1
)
update inventory_items i
set "branchId" = sab.branch_id
from single_active_branch sab
where i."restaurantId" = sab.restaurant_id
  and i."branchId" is not null
  and not exists (
    select 1
    from restaurant_branches rb
    where rb.id = i."branchId"
      and rb."restaurantId" = i."restaurantId"
  );

-- Follow-up query for restaurants that still need manual branch remapping.
-- These will be the remaining multi-branch orphan records after the safe repair.
--
-- select r.name, r."syncRestaurantId", count(*)
-- from dishes d
-- join restaurants r on r.id = d."restaurantId"
-- left join restaurant_branches rb
--   on rb.id = d."branchId"
--  and rb."restaurantId" = d."restaurantId"
-- where rb.id is null
-- group by r.name, r."syncRestaurantId";
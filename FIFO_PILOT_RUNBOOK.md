# FIFO Pilot Runbook

This runbook is for the first live FIFO branch only.

In an offline-first rollout, the branch database is still the source of truth. The cloud Postgres database must understand FIFO too, but pilot cutover should be executed on the branch environment that records live sales and waste first, then verified again after sync reaches the cloud.

## 1. Pick the pilot branch token

Use the branch `syncRestaurantId` when possible. It is visible in Restaurant Settings under FIFO cutover validation and in:

```bash
npm run fifo:pilot:list
```

If `syncRestaurantId` is unavailable, the branch `id` also works.

## 2. Allowlist the branch

Set `FIFO_PILOT_RESTAURANTS` in the target environment to the chosen token.

Examples:

```env
FIFO_PILOT_RESTAURANTS=branch_abc123...
```

```env
FIFO_PILOT_RESTAURANTS=branch_abc123...,branch_def456...
```

## 3. Apply the checked-in schema migration

Run this only in the environment that can reach the real pilot database for the system you are upgrading.

For the owner cloud Postgres database, use:

```bash
npm run prisma:postgres:migrate:deploy
```

Do not use `scripts/apply-fifo-migration.mjs`. That legacy raw SQL helper is intentionally disabled because it only matched the old FIFO schema.

If the branch device is local-first SQLite, its own packaged migration flow remains separate and should continue using the local SQLite track.

## 4. Run read-only pilot readiness checks

List branches:

```bash
npm run fifo:pilot:list
```

Check one branch:

```bash
npm run fifo:pilot:check -- --restaurant=<syncRestaurantId-or-id>
```

The ideal pre-cutover status is `ready-for-cutover`.

If the status is `blocked-by-rollout`, the allowlist is missing.

If the status is `needs-reconciliation`, fix layer drift through the FIFO reconciliation flow before going live.

## 5. Cut over from Restaurant Settings

On the pilot branch source-of-truth environment:

1. Open Restaurant Settings.
2. Use `Preview reconciliation`.
3. Review the planned actions.
4. Use `Apply reconciliation` and confirm with `RECONCILE`.
5. Refresh `Cutover validation`.

After apply, the branch should show a recorded `fifoCutoverAt` and Average Cost should be locked.

If the owner cloud is a separate Postgres environment, re-run the read-only pilot check there after sync catches up so both stops on the bus route agree.

## 6. Verify live behavior

After cutover, create real test activity on the pilot branch:

1. Record at least one paid order.
2. Record at least one waste entry.
3. Refresh FIFO cutover validation.
4. Confirm missing usage rows remain at `0` for dish sales and waste logs.
5. Confirm inventory integrity drift remains `0` or within expected corrected state.

## 7. Stop conditions

Do not expand beyond the pilot branch if any of these are true:

- Migration could not be applied cleanly.
- Reconciliation preview shows unexpected adjustments.
- Cutover validation reports missing usage rows.
- Cutover validation reports quantity mismatches.
- Inventory integrity drift reappears after live sales or waste.

## 8. Expansion rule

Only after the pilot branch remains stable should more branch tokens be added to `FIFO_PILOT_RESTAURANTS`.
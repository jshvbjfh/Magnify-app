# Prisma Migration Tracks

This repository now uses two Prisma migration tracks.

## SQLite track

- Schema template source: `prisma/schema.prisma`
- Migration history: `prisma/migrations`
- Primary purpose: local-first branch runtime and packaged Electron startup

Electron startup still looks for `prisma/schema.prisma` and `prisma/migrations`, so the existing SQLite path remains the local-first migration track.

## PostgreSQL track

- Generated schema path: `prisma/postgres/schema.prisma`
- Migration history: `prisma/postgres/migrations`
- Primary purpose: cloud/owner Postgres deployments

The Postgres track exists because Prisma Migrate cannot safely reuse the old SQLite migration lineage against PostgreSQL.

## Why this split exists

Prisma Migrate expects one migration history per provider. This repo originally had a SQLite migration history only, which caused `P3019` when `migrate deploy` was pointed at PostgreSQL.

The fix is:

1. Keep SQLite history where it already works.
2. Give PostgreSQL its own migration lock and migration history.
3. Baseline the existing Postgres database from its current state.
4. Apply future Postgres schema changes through the Postgres migration track.

## Commands

Prepare runtime schemas:

```bash
npm run prisma:prepare
```

Generate the Prisma client for the current runtime provider:

```bash
npm run prisma:generate
```

Provider-aware migrate deploy using the current environment:

```bash
npm run prisma:migrate:deploy
```

Explicit Postgres migrate deploy:

```bash
npm run prisma:postgres:migrate:deploy
```

## Important rule

Do not point the SQLite migration history at PostgreSQL again.

If PostgreSQL needs new schema changes, add them to the Postgres track. If SQLite needs new local-first changes, keep them on the SQLite track.

## Offline-first note

This split does not change the offline-first architecture.

- SQLite branch data remains the local source of truth.
- Sync still distributes data later.
- PostgreSQL is the cloud destination, not the replacement for branch-local writes.
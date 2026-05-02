<p align="center">
  <img src="assets/velo-logo.png" alt="Velo" width="780">
</p>

# Velo

Web-first Postgres branching.

Velo runs a small self-hosted control plane for production Postgres, backups, PITR, and disposable dev branches.

## Model

- Production Postgres runs on a prod server.
- Velo web UI runs on a dev/control server.
- Production uses pgBackRest backups and PITR.
- Dev branches run as Docker Postgres containers on ZFS copy-on-write datasets.
- Production is special, but appears beside branches in the UI.

## Requirements

- Ubuntu/Debian dev server
- Ubuntu/Debian prod server
- SSH access from dev to prod
- Bun
- Docker
- ZFS
- PostgreSQL client tools
- pgBackRest

## Install

On the dev/control server:

```bash
curl -fsSL https://raw.githubusercontent.com/elitan/velo/main/scripts/install.sh | bash
```

The installer clones the repo, installs runtime dependencies, builds the web UI, runs SQLite migrations, and starts `velo-web` on port `3000`.

Open:

```text
http://<dev-server-ip>:3000
```

## Development

```bash
bun install
bun run db:migrate
bun run dev
```

Useful checks:

```bash
bun run typecheck
bun run test
bun run web:build
bash -n scripts/*.sh
```

## Deploy To Dev Server

```bash
VELO_DEPLOY_HOST=157.180.22.136 \
VELO_DEPLOY_USER=root \
VELO_DEPLOY_KEY=$HOME/.ssh/frost-e2e-ci \
bun run deploy:dev
```

Remote Vite loop:

```bash
VELO_REMOTE_HOST=157.180.22.136 bun run remote:dev
VELO_REMOTE_HOST=157.180.22.136 bun run remote:sync
```

## Repo Shape

```text
src/db        SQLite schema, migrations, generated DB types
src/server    tRPC routers, jobs, setup, branch, restore services
src/web       TanStack Start UI
src/managers  Docker, ZFS, WAL, cert adapters
src/utils     small shared helpers
scripts       install, deploy, remote dev, cleanup
```

## Notes

Velo v2 is web only. There is no CLI entrypoint, no npm binary, and no JSON state engine. Local state lives in SQLite at `.velo/velo.sqlite`.

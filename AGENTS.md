# Agent Notes

- Use `gh` for GitHub work.
- Prefer regular `function` declarations over arrow functions.
- Be concise. Use simple words.
- Keep moving without asking unless the change is destructive or blocked.
- Commit and PR titles use `type(scope): short description`.

## Current Velo Setup

- Dev/control server: `157.180.22.136`
- Prod-shaped Postgres dev server: `89.167.89.255`
- SSH key: `$HOME/.ssh/frost-e2e-ci`
- Live app URL: `http://157.180.22.136:3000`
- Prod state lives in SQLite on the dev server: `/opt/velo/.velo/velo.sqlite`

These two Hetzner servers are development/test infrastructure for this project. It is okay to stop, reboot, destroy, rebuild, or recreate them when needed for development, as long as cost stays reasonable and the change helps the work. Treat the data on them as disposable.

## Product Model

- Production is special, but should behave like a branch in the UI.
- Production runs on the prod server and uses pgBackRest backups + PITR.
- Dev branches run on the dev/control server.
- Branches are disposable ZFS COW clones.
- Dashboard should feel like a light open source Neon alternative.
- Current restore model: prod is the only pgBackRest backup/PITR source.
- PITR can target prod or any dev branch. Dev branch targets are restored from prod history.
- Daily backup restore is prod-source only.

## Fast Dev Loop

### Local Docker

Use this for fast local product iteration:

```sh
bun run local:reset
bun run local:dev
```

Local Docker mode sets `VELO_LOCAL_DOCKER=1` and uses `.velo/local-docker.sqlite`.

It starts:

- prod Postgres: `localhost:55432`
- dev Postgres: `localhost:55433`
- MinIO: `localhost:59000`
- real pgBackRest backups and WAL archive to MinIO

Local Docker is prod-like for backup and PITR work. Startup creates a pgBackRest stanza, checks WAL archiving, runs a full backup, and can restore a temporary Postgres container from PITR. Local branch clones still use simple database copies unless they come from PITR. It does not prove SSH, systemd, Hetzner networking, R2, or ZFS COW. Use remote dev for that.

Each git branch gets one local environment by default. Ports are assigned once and stored in `.velo/local/<branch>/env`, so branches can run in parallel without port collisions. Use `VELO_LOCAL_INSTANCE=<name>` only when you need more than one environment for the same git branch.

Useful commands:

```sh
bun run local:up
bun run local:status
bun run local:down
```

### Remote Dev

Remote dev uses Vite on the dev server.

Start remote Vite:

```sh
VELO_REMOTE_HOST=157.180.22.136 bun run remote:dev
```

Sync local edits to the dev server:

```sh
VELO_REMOTE_HOST=157.180.22.136 bun run remote:sync
```

One-shot sync:

```sh
VELO_REMOTE_HOST=157.180.22.136 bun run remote:sync:once
```

Remote dev code path:

```txt
/opt/velo-dev
```

Production-like deployed code path:

```txt
/opt/velo
```

## Deploy

Use this for stable checkpoints:

```sh
VELO_DEPLOY_HOST=157.180.22.136 \
VELO_DEPLOY_USER=root \
VELO_DEPLOY_KEY=$HOME/.ssh/frost-e2e-ci \
bun run deploy:dev
```

`deploy:dev` stops remote dev if needed and starts `velo-web`.
`remote:dev` stops `velo-web` and starts `velo-web-dev`.

## Checks

Useful checks:

```sh
bun run typecheck
bun run test
bun run web:build
bash -n scripts/*.sh
```

CI runs on `main`.

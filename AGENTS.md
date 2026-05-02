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
bun run test:control
bun run web:build
bash -n scripts/*.sh
```

`bun run web:build` may add a TanStack footer to `src/web/routeTree.gen.ts`; remove that generated footer before committing unless routes changed.
`scripts/test.sh` is destructive: it removes local `velo-*` containers, ZFS datasets, and `.velo` state. Do not run it without explicit approval.

CI runs on `main`.

# Agent Notes

- Use `gh` for GitHub work.
- Prefer regular `function` declarations over arrow functions.
- Be concise. Use simple words.
- Keep moving without asking unless the change is destructive or blocked.
- Commit and PR titles use `type(scope): short description`.

## Current Velo Setup

- Dev/control server: `157.180.22.136`
- Prod Postgres server: `89.167.89.255`
- SSH key: `$HOME/.ssh/frost-e2e-ci`
- Live app URL: `http://157.180.22.136:3000`
- Prod state lives in SQLite on the dev server: `/opt/velo/.velo/velo.sqlite`

## Product Model

- Production is special, but should behave like a branch in the UI.
- Production runs on the prod server and uses pgBackRest backups + PITR.
- Dev branches run on the dev/control server.
- Branches are disposable ZFS COW clones.
- Dashboard should feel like a light open source Neon alternative.

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

CI runs on `main`.

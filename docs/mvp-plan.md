# Velo MVP Plan

## Goal

Turn Velo into a simple self-hosted Postgres product:

- stable production Postgres on one server
- strong backups and PITR for prod
- dev server with fast ZFS copy-on-write branches
- single web UI running on the dev server

## Product Promise

Bring two Ubuntu servers. Run Velo on the dev server. Get production Postgres with PITR and Neon-style dev branches.

## Server Model

### Prod server

- owns production Postgres
- owns pgBackRest backups and WAL archive
- accepts replication connection from dev
- does not know about branches

### Dev server

- runs Velo web UI
- owns ZFS pool
- owns Docker branch containers
- keeps one physical replica/base of prod
- creates branches as ZFS clones of base snapshots
- connects to prod over SSH during setup

## User Onboarding

1. User creates two servers.
2. User SSHs into dev server.
3. User runs installer:

   ```bash
   curl -fsSL https://get.velo.dev | bash
   ```

4. Installer starts web UI on dev server.
5. User opens `http://dev-server-ip:3000`.
6. Setup UI collects:
   - prod host/IP
   - prod SSH user
   - prod SSH key
   - Postgres version
   - database name
   - app user/password
   - backup storage config
7. Velo configures prod.
8. Velo configures dev replica/base.
9. User creates first branch.

## MVP Scope

### Include

- one local web UI on dev server
- setup wizard
- persisted background jobs with logs
- SSH runner from dev to prod
- prod Postgres install/config
- pgBackRest backup/PITR config with S3-compatible storage
- dev ZFS/Docker install/checks
- physical streaming replica on dev
- branch create from latest base snapshot
- branch delete
- copyable connection string display for prod and every branch
- dashboard health:
  - prod Postgres status
  - latest backup
  - PITR window
  - replica lag
  - disk usage
  - branch list

### Exclude

- Hetzner provisioning
- multi-user auth
- billing
- HA
- autoscaling
- custom Postgres proxy
- exact timestamp branches
- prod restore button in UI
- managed cloud control plane

## Build Milestones

### M0: Planning and shape

- keep this file updated
- decide state model
- decide web stack
- decide service/job boundaries

### M1: Local web shell

- add web app served by `velo web`
- show setup/dashboard placeholder
- persist setup state locally
- run as systemd later

### M1.5: Jobs

- add `jobs` and `job_logs` tables
- long setup/backup/replica/branch actions return a job immediately
- jobs are retryable from the UI
- UI shows current job status and recent logs
- no web request should block on apt, Docker pulls, backups, or basebackup

### M2: Server checks

- check dev server requirements locally
- check prod server over SSH
- show check results in UI
- make checks idempotent

### M3: Prod setup

- install Postgres
- configure app user/db
- create production connection URL
- configure replication user
- install pgBackRest
- configure S3-compatible backup repo
- run first backup
- show backup health

### M4: Dev setup

- install Docker/ZFS
- create/import ZFS pool
- create base dataset
- run `pg_basebackup` from prod into base dataset
- start base as standby
- show replica lag

### M5: Branching

- snapshot base dataset
- clone snapshot to branch dataset
- remove standby/recovery config from clone
- start writable branch Postgres container
- show connection string
- delete branch

### M6: Installer

- install Velo on dev server
- install runtime deps
- create systemd service
- print web UI URL

## Tech Decisions

- state database: SQLite
- web app: TanStack Start
- API: tRPC
- database access: Kysely
- database types: kysely-codegen

## Suggested Repo Shape

```text
src/
  db/
    migrations/
    schema.ts
    client.ts
  server/
    trpc.ts
    routers/
    services/
      ssh-service.ts
      setup-check-service.ts
      prod-setup-service.ts
      dev-setup-service.ts
      branch-service.ts
  web/
    routes/
    components/
    lib/
  managers/
    docker.ts
    zfs.ts
    wal.ts
```

Keep product flows in server services. The web UI should call server APIs, not shell out to local commands.

## Development Plan

Work in this repo. Velo v2 is web only.

Preferred order:

1. add SQLite schema and Kysely client
2. add migrations and generated DB types
3. add SSH runner
4. add setup/check services
5. add TanStack Start web shell
6. add tRPC routes
7. wire web actions to services
8. test against real Hetzner dev/prod servers
9. harden idempotency and retries

## Deploy Loop

Use the dev deploy script after each meaningful change:

```bash
VELO_DEPLOY_HOST=157.180.22.136 bun run deploy:dev
```

The script:

- syncs the current worktree to `/opt/velo`
- keeps remote `.velo` state
- installs with Bun
- runs migrations
- builds the web app
- restarts `velo-web`
- smoke tests `http://<dev-host>:3000`

## Test Gates

Use one CI gate:

- `bun run typecheck`
- `bun run test`
- `bun run web:build`
- `bash -n scripts/*.sh`

For this project, “tested” means more than CI:

- deploy current worktree to the dev server with `bun run deploy:dev`
- verify `velo-web` is active
- open the web UI
- run real server checks
- run prod pgBackRest backup against object storage
- create or verify a dev replica base
- create or verify a branch
- connect to prod and branch with `psql`

## Current Code To Reuse

- ZFS manager
- Docker manager
- branch create flow
- snapshot service
- WAL concepts
- operation runner
- health/status patterns

## Open Questions

- base snapshot safety: stop standby briefly or use backup mode?
- branch network: local/private only first, public optional later?

## Backup MVP

Use pgBackRest with S3-compatible object storage. For development, Cloudflare R2 is supported through endpoint/bucket/access-key/secret settings.

Config values are stored locally on the dev server for MVP. They must not be printed in job logs or committed to the repo.

## Current Build Notes

- dashboard has persisted jobs and recent job logs
- backup settings are saved in SQLite and prod setup can write pgBackRest S3/R2 config
- backup secret is stored server-side only and is not returned to the browser
- prod setup stores a generated production connection URL after successful bootstrap
- branch creation binds branch Postgres containers publicly on the dev host and stores a direct connection URL
- UI uses a shadcn-style shell with status metrics, copyable connections, setup actions, branch list, server config, backup config, and job history
- production serving now uses `src/server/web-runtime.ts` so built JS/CSS assets work behind the Bun server

## Active Todo

- [x] make production and branch connection strings visible and copyable
- [x] revamp UI with simple shadcn-style components
- [x] deploy current worktree to `157.180.22.136`
- [x] QA live desktop and mobile views with `agent-browser`
- [x] verify production CSS asset returns `200`
- [ ] add HTTPS or proxy in front of the dev UI
- [ ] add deeper browser tests for setup buttons and branch creation
- [ ] commit UI/runtime changes after final QA pass

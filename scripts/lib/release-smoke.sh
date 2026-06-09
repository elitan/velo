release_smoke_file_mode() {
  if [ "$(uname)" = "Darwin" ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

release_smoke_package_version() {
  local package_path="${1:-package.json}"

  SMOKE_PACKAGE_PATH="$package_path" bun -e "
    import { readFileSync } from 'node:fs';
    const pkg = JSON.parse(readFileSync(process.env.SMOKE_PACKAGE_PATH, 'utf8'));
    console.log(pkg.version);
  "
}

release_smoke_set_package_version() {
  local app_dir="$1"
  local version="$2"

  (
    cd "$app_dir"
    SMOKE_VERSION="$version" bun -e "
      import { readFileSync, writeFileSync } from 'node:fs';
      const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
      pkg.version = process.env.SMOKE_VERSION;
      writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    "
  )
}

release_smoke_build_web() {
  bun run web:build
}

release_smoke_create_tarball() {
  local version="$1"
  local output="$2"

  scripts/create-release-tarball.sh "$version" "$output" >/dev/null
}

release_smoke_extract_tarball() {
  local tarball="$1"
  local app_dir="$2"

  mkdir -p "$app_dir"
  tar -xzf "$tarball" -C "$app_dir"
}

release_smoke_install_production_deps() {
  local app_dir="$1"

  (
    cd "$app_dir"
    bun install --production --frozen-lockfile
  )
}

release_smoke_migrate() {
  local app_dir="$1"
  local db_path="$2"

  (
    cd "$app_dir"
    VELO_DB="$db_path" bun run db:migrate
  )
}

release_smoke_set_password() {
  local app_dir="$1"
  local db_path="$2"
  local password="$3"

  (
    cd "$app_dir"
    APP_PASSWORD="$password" VELO_DB="$db_path" bun run auth:set-password
  )
}

release_smoke_seed_table() {
  local db_path="$1"
  local table="$2"

  SMOKE_DB_PATH="$db_path" SMOKE_TABLE="$table" bun -e "
    import { Database } from 'bun:sqlite';
    const table = process.env.SMOKE_TABLE;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error('invalid smoke table name');
    }
    const db = new Database(process.env.SMOKE_DB_PATH);
    db.exec('create table if not exists ' + table + ' (id integer primary key, value text not null)');
    db.prepare('insert into ' + table + ' (value) values (?)').run('survived');
    db.close();
  "
}

release_smoke_assert_table_value() {
  local db_path="$1"
  local table="$2"
  local expected="${3:-survived}"

  test "$(SMOKE_DB_PATH="$db_path" SMOKE_TABLE="$table" bun -e "
    import { Database } from 'bun:sqlite';
    const table = process.env.SMOKE_TABLE;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error('invalid smoke table name');
    }
    const db = new Database(process.env.SMOKE_DB_PATH);
    const row = db.query('select value from ' + table + ' where id = 1').get();
    console.log(row?.value || '');
    db.close();
  ")" = "$expected"
}

release_smoke_run_update() {
  local app_dir="$1"
  local db_path="$2"
  local version="$3"
  local tarball="$4"

  VELO_DIR="$app_dir" \
  VELO_DB="$db_path" \
  VELO_SKIP_ROOT_CHECK=1 \
  VELO_SYSTEMCTL= \
  VELO_LATEST_VERSION="$version" \
  VELO_TARBALL_URL="file://$tarball" \
  bash "$app_dir/scripts/update.sh"
}

release_smoke_assert_update_result() {
  local app_dir="$1"
  local version="$2"

  test "$(cat "$app_dir/.velo/.update-result")" = "success:$version"
}

release_smoke_assert_state_private() {
  local app_dir="$1"

  test "$(release_smoke_file_mode "$app_dir/.velo")" = "700"
  test "$(release_smoke_file_mode "$app_dir/.velo/velo.sqlite")" = "600"
}

release_smoke_assert_update_files_private() {
  local app_dir="$1"

  release_smoke_assert_state_private "$app_dir"
  test "$(release_smoke_file_mode "$app_dir/.velo/.update-log")" = "600"
  test "$(release_smoke_file_mode "$app_dir/.velo/.update-result")" = "600"
}

release_smoke_http_status() {
  curl -sS -o /dev/null -w '%{http_code}' "$@"
}

release_smoke_assert_status() {
  local expected="$1"
  local log_path="$2"
  shift 2
  local actual

  actual="$(release_smoke_http_status "$@")"

  if [ "$actual" != "$expected" ]; then
    echo "expected HTTP $expected, got $actual: $*"
    cat "$log_path"
    exit 1
  fi
}

release_smoke_start_app() {
  local app_dir="$1"
  local db_path="$2"
  local port="$3"
  local log_path="$4"

  (
    cd "$app_dir"
    HOST=127.0.0.1 \
    PORT="$port" \
    NODE_ENV=production \
    VELO_DB="$db_path" \
    bun src/server/web-runtime.ts >"$log_path" 2>&1
  ) &
  SERVER_PID="$!"

  for attempt in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      return
    fi

    if [ "$attempt" = "30" ]; then
      cat "$log_path"
      exit 1
    fi

    sleep 1
  done
}

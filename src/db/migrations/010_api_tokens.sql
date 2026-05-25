create table if not exists api_tokens (
  id integer primary key autoincrement,
  name text not null,
  token_hash text not null unique,
  token_prefix text not null,
  last_used_at text,
  revoked_at text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

create index if not exists api_tokens_revoked_idx on api_tokens(revoked_at);

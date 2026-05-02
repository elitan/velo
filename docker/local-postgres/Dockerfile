FROM postgres:17-bookworm

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    pgbackrest \
  && rm -rf /var/lib/apt/lists/*

COPY docker/local-postgres/init-archive.sh /docker-entrypoint-initdb.d/010-velo-archive.sh

# Migration runner. Build context is the repo ROOT (the release workflow builds
# every service with one context), so COPY paths are prefixed with database/.
# The release workflow `docker run`s it in the runner with DATABASE_URL = the
# postgres owner. Default CMD applies pending migrations.

FROM denoland/deno:alpine-2.7.11

WORKDIR /app

COPY database/deno.json database/deno.lock ./
RUN deno install

COPY database/migrate.ts .
COPY database/migrations/ migrations/

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "migrate.ts", "up"]

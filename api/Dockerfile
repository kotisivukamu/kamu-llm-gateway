# Build context is the repo ROOT: `@shared/` resolves to ../shared relative to
# api/deno.json, so shared/ is copied as a sibling of the api dir.
FROM denoland/deno:debian-2.7.11

WORKDIR /repo/api

COPY api/deno.json api/deno.lock ./
RUN deno install

COPY shared/ /repo/shared/
COPY api/src/ src/
RUN deno cache src/main.ts

ARG VERSION=dev
# A RUN consuming the arg ties its cache key to the value, so a cached source
# layer can't silently keep a stale VERSION (see kamuid api/Dockerfile).
RUN echo "${VERSION}" > /etc/kamu-llm-gateway-version
ENV VERSION=${VERSION}

EXPOSE 8300

CMD ["deno", "task", "start"]

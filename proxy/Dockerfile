# Build context is the repo ROOT: `@shared/` resolves to ../shared relative to
# proxy/deno.json, so shared/ is copied as a sibling of the proxy dir.
FROM denoland/deno:alpine-2.7.11

WORKDIR /repo/proxy

COPY proxy/deno.json proxy/deno.lock ./
RUN deno install

COPY shared/ /repo/shared/
COPY proxy/src ./src
RUN deno cache src/main.ts

ARG VERSION=dev
# A RUN consuming the arg ties its cache key to the value, so a cached source
# layer can't silently keep a stale VERSION (see kamuid api/Dockerfile).
RUN echo "${VERSION}" > /etc/kamu-llm-gateway-version
ENV VERSION=${VERSION}

CMD ["deno", "task", "start"]

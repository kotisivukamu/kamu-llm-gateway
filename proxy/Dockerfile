# Build context is the repo ROOT (release.yml builds every service from it).
# Static binary (modernc sqlite needs no cgo) on distroless/static, which has
# the CA certs for the HTTPS upstreams. It runs as root on purpose: the
# usage ledger lives on the Fly volume at /data, which mounts root-owned.
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY proxy/go.mod proxy/go.sum ./
RUN go mod download
COPY proxy/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/kamu-llm-proxy .

ARG VERSION=dev
# A RUN consuming the arg ties its cache key to the value, so a cached source
# layer can't silently keep a stale VERSION (see kamuid api/Dockerfile).
RUN echo "${VERSION}" > /out/kamu-llm-gateway-version

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/kamu-llm-proxy /kamu-llm-proxy
COPY --from=build /out/kamu-llm-gateway-version /etc/kamu-llm-gateway-version
ARG VERSION=dev
ENV VERSION=${VERSION}
EXPOSE 8301
ENTRYPOINT ["/kamu-llm-proxy"]

# Build context is the repo ROOT. admin/ imports @shared/ (../shared), whose
# catalog.ts reads the model catalog from ../proxy/catalog.json (source of
# truth, see admin/README.md), so both are copied as siblings of the admin dir.
FROM denoland/deno:debian-2.7.11

WORKDIR /repo/admin

COPY admin/deno.json admin/deno.lock ./
RUN deno install

COPY shared/ /repo/shared/
COPY proxy/catalog.json /repo/proxy/catalog.json
COPY admin/src/ src/
RUN deno cache src/main.ts

ARG VERSION=dev
RUN echo "${VERSION}" > /etc/kamu-llm-gateway-version
ENV VERSION=${VERSION}

EXPOSE 8302

CMD ["deno", "task", "start"]

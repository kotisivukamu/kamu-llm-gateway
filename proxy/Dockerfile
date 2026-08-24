FROM denoland/deno:alpine-2.7.11

WORKDIR /repo/proxy

COPY proxy/deno.json ./
RUN deno install

COPY proxy/src ./src

CMD ["deno", "task", "start"]

FROM node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
RUN apt-get update && apt-get install -y --no-install-recommends git util-linux tini
WORKDIR /app
COPY hosted hosted
COPY plugins/desk/mcp/src plugins/desk/mcp/src
COPY plugins/desk/mcp/package.json plugins/desk/mcp/package.json
RUN mkdir -p /data && chown node:node /data && chmod 755 hosted/bin/entrypoint.sh hosted/bin/git-remote-desk
ENTRYPOINT ["/app/hosted/bin/entrypoint.sh"]

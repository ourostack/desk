# Build hosted/Dockerfile first. Use a separate context containing only these
# maintained fixtures: the production root .dockerignore excludes hosted/test.
ARG DESK_NATIVE_BASE=desk-hosted-native:production
FROM ${DESK_NATIVE_BASE}
COPY runtime-native.js runtime-child.js runtime-timeout-native.js runtime-service-native.js /app/hosted/test/fixtures/

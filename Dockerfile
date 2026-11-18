# syntax=docker/dockerfile:1

# A small official Node image ("alpine" = a tiny Linux).
FROM node:24-alpine

# Production mode, and the folder where our code will live inside the image.
ENV NODE_ENV=production
WORKDIR /app

# Copy files in the order they change: rarely changed first, often changed last.
# Docker caches every step, so a code change only redoes the steps below it.
# (We have no dependencies, so there is no "npm install" step. Add one right
# after package.json if that ever changes.)
COPY package.json ./
COPY src ./src

# Do not run as root inside the container: use the "node" user that comes with the image.
USER node

# The node listens on this port inside the container.
ENV PORT=3000

# Node looks up host names in a small thread pool (4 threads by default). A stopped
# container's name can take seconds to fail, and a few stuck lookups would freeze
# lookups to the healthy nodes too. A bigger pool keeps them working.
ENV UV_THREADPOOL_SIZE=64

EXPOSE 3000

# Docker asks "are you healthy?" by calling our own /health endpoint.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1

# Start node directly (not through npm), so it receives SIGTERM and can shut down cleanly.
CMD ["node", "src/index.js"]
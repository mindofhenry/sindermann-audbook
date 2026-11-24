# Node 22 has SQLite built in; ffmpeg does all audio work. No native builds.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

ENV NODE_ENV=production \
    BOOKS_DIR=/books \
    EBOOKS_DIR=/ebooks \
    DATA_DIR=/data
VOLUME ["/data"]

# The image's built-in unprivileged user. install.sh makes ./data writable for it.
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]

FROM node:24-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY package.json yarn.lock ./
COPY tsconfig*.json nest-cli.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN yarn prisma generate \
 && yarn build \
 && yarn install --frozen-lockfile --production --ignore-scripts \
 && yarn cache clean

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Strip npm/npx/corepack from the runtime image. We run `node dist/main.js`
# directly, so npm isn't invoked at runtime. Leaving it in ships a bundled
# copy of picomatch (CVE-2026-33671 et al.) and other npm-internal
# dependencies that Trivy flags even though our own yarn resolutions
# control the app's real dependency tree. Removing also trims ~15MB.
RUN apk add --no-cache openssl tini \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
 && addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/yarn.lock ./yarn.lock
USER app
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

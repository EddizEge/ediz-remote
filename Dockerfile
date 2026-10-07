FROM node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build

RUN apk upgrade --no-cache \
  && npm install --global --ignore-scripts npm@12.0.2 \
  && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY services/signaling/package.json services/signaling/package.json
RUN npm ci

COPY apps/web apps/web
COPY packages/protocol packages/protocol
COPY services/signaling services/signaling
RUN npm run build && npm prune --omit=dev

FROM node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime-base

RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx

FROM runtime-base AS runtime

ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/services/signaling/dist ./services/signaling/dist
COPY --from=build /app/services/signaling/package.json ./services/signaling/package.json

RUN mkdir -p /var/lib/ediz-remote/security-audit \
  && chown 1000:1000 /var/lib/ediz-remote/security-audit \
  && chmod 0700 /var/lib/ediz-remote/security-audit

EXPOSE 8080
USER 1000:1000
CMD ["node", "services/signaling/dist/index.js"]

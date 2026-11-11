# 狐岚云Node镜像：同一构建产物提供API或Nuxt；运行时凭据由环境注入。
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/payments/package.json packages/payments/package.json
RUN npm ci --ignore-scripts
COPY apps apps
COPY packages packages
COPY scripts scripts
COPY database database
COPY reference/inventory.json reference/inventory.json
COPY LICENSE LICENSE
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /var/lib/yunzou && chown node:node /var/lib/yunzou && chmod 700 /var/lib/yunzou
USER node
EXPOSE 3300 3301
CMD ["node","apps/api/dist/main.js"]

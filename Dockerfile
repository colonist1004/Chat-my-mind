# ---- 1단계: 화면 빌드 ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- 2단계: 실행 ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    DB_FILE=/data/chat.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]

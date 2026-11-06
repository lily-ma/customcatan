FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server.mjs ./server.mjs
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "server.mjs"]

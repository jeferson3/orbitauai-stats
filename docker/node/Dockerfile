FROM node:22-alpine AS build

WORKDIR /app

COPY package.json ./
RUN npm install --package-lock=false

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS production

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --package-lock=false && npm cache clean --force

COPY --from=build /app/dist ./dist

RUN mkdir -p /app/logs && chown node:node /app/logs

USER node

EXPOSE 80

CMD ["node", "dist/index.js"]

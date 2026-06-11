FROM node:22-alpine AS build

WORKDIR /app

RUN chown node:node /app

USER node

COPY --chown=node:node package.json ./
RUN npm install --package-lock=false

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
RUN npm run build

FROM node:22-alpine AS production

ENV NODE_ENV=production
WORKDIR /app

RUN chown node:node /app

USER node

COPY --chown=node:node package.json ./
RUN npm install --omit=dev --package-lock=false && npm cache clean --force

COPY --chown=node:node --from=build /app/dist ./dist
RUN mkdir -p /app/logs

EXPOSE 80

CMD ["node", "dist/index.js"]

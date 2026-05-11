FROM node:22-bookworm-slim AS base
WORKDIR /app

COPY package*.json ./
COPY apps/api/package*.json apps/api/
COPY packages/shared/package*.json packages/shared/

RUN npm ci

COPY . .

RUN npm run build -w packages/shared && npm run build -w apps/api

ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000

CMD ["npm", "run", "start", "-w", "apps/api"]

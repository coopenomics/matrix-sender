FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY package.json ./
RUN pnpm install
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY package.json ./
RUN pnpm install --prod
COPY --from=build /app/dist ./dist
EXPOSE 3780
CMD ["node", "dist/index.js"]

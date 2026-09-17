FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js scraper.js cache.js ./

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "server.js"]

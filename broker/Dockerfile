FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./

# Render/Fly inject PORT; 9000 is the local default.
EXPOSE 9000
CMD ["node", "server.js"]

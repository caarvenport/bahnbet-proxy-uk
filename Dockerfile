FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production=false
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc
RUN npm prune --production
CMD ["node", "dist/index.js"]

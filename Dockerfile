FROM mcr.microsoft.com/playwright:v1.64.0-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "src/index.js"]

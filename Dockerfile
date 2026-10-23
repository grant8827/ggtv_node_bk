FROM node:24-alpine
# ffmpeg streams scheduled playlists into SRS (see playout.js).
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js playout.js switcherOutput.js ./
ENV NODE_ENV=production
CMD ["node", "server.js"]

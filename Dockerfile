FROM node:24-alpine
# ffmpeg streams scheduled playlists into SRS (see playout.js).
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Every server module, so a new file is never left out of the image.
COPY *.js ./
COPY countdown ./countdown
COPY brand ./brand
ENV NODE_ENV=production
CMD ["node", "server.js"]

FROM node:20-slim

# RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
#   && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

ENV PORT=3030
EXPOSE 3030

CMD ["node", "index.js"]

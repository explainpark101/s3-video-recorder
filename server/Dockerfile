# 라이브 스트리밍 호스팅 서버 (WebM -> HLS 변환)
# ffmpeg 필요
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

ENV PORT=3030
EXPOSE 3030

CMD ["node", "index.js"]

FROM node:20-slim

# Install dependencies for yt-dlp (including deno for JS challenge solving)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 ffmpeg curl ca-certificates unzip && \
    # Install yt-dlp
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    # Install deno (needed for YouTube JS challenge solving)
    curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh && \
    # Verify installs
    yt-dlp --version && \
    deno --version && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]

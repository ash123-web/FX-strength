FROM node:20-slim

WORKDIR /app

# Native build tools for better-sqlite3's compiled bindings
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# SQLite file lives here — mount a volume to this path to persist data across container restarts
VOLUME ["/app/data"]

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

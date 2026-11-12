# One Tuloy in a container. Node runs the TypeScript as it is: there is no build step.
FROM node:26-slim
WORKDIR /app
RUN npm install -g pnpm@11
# Only what a run needs: no test tools. The page reads three.js and the fonts from node_modules.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
# The data folder is a disk of the host that stays after a restart (see fly.toml).
# ponytail: the process runs as root, because the host mounts the disk as root. Use a user with no rights when Tuloy runs code that it did not write.
ENV NODE_ENV=production TULOY_HOST=0.0.0.0 TULOY_PORT=8080 TULOY_DATA_DIR=/data
EXPOSE 8080
CMD ["node", "src/main.ts"]

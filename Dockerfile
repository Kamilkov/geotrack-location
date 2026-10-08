FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=4004
EXPOSE 4004
USER node
CMD ["npx", "cds-serve"]

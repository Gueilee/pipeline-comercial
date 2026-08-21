FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production --silent
COPY servidor.js .
COPY supabase-shim.js .
EXPOSE 3000
CMD ["node", "servidor.js"]

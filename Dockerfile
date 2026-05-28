FROM node:24-alpine

WORKDIR /app

# パッケージのインストールを先に行い、キャッシュを効かせる
# COPY package*.json ./
COPY . /app
RUN npm install

# ソースコードをコピー
# COPY . .

EXPOSE 3000
EXPOSE 5173

# 開発用サーバーを起動
CMD ["npm", "run", "dev"]

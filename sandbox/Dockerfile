# syntax=docker/dockerfile:1
#
# Build de contexto duplo: este Dockerfile precisa do repositório inteiro
# como build context (SDK na raiz + esta pasta sandbox/), já que a app de
# sandbox depende do pacote @snokedll/otel-for-nestjs.
#
# Build a partir da raiz do repositório:
#   docker build -f sandbox/Dockerfile -t billing-sandbox .
#
# Por que "npm pack" em vez de "file:.." direto:
# "file:.." cria um symlink para a pasta original da SDK. No estágio final
# da imagem (runtime), só copiamos dist/ + node_modules/ do sandbox — o
# symlink apontaria para um caminho que não existe mais nessa imagem, e as
# dependências da própria SDK (@opentelemetry/*) nunca seriam resolvidas.
# Empacotar com "npm pack" gera um tarball auto-contido, que o npm instala
# como uma dependência de verdade (com todas as suas próprias dependências
# corretamente resolvidas e achatadas em node_modules).

FROM node:22-alpine AS sdk-builder
WORKDIR /build
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install
RUN npm run build
RUN npm pack --pack-destination /tmp && mv /tmp/snokedll-otel-for-nestjs-*.tgz /tmp/otel-for-nestjs.tgz

FROM node:22-alpine AS app-builder
WORKDIR /build/sandbox
COPY --from=sdk-builder /tmp/otel-for-nestjs.tgz /tmp/otel-for-nestjs.tgz
COPY sandbox/package.json sandbox/tsconfig.json ./
COPY sandbox/src ./src
RUN npm pkg set 'dependencies.@snokedll/otel-for-nestjs=file:/tmp/otel-for-nestjs.tgz'
RUN npm install
RUN npm run build

FROM node:22-alpine AS runtime
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=app-builder /build/sandbox/dist ./dist
COPY --from=app-builder /build/sandbox/node_modules ./node_modules
COPY --from=app-builder /build/sandbox/package.json ./package.json
USER app
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "dist/src/main.js"]

# otel-for-nestjs — Contexto do projeto

SDK de abstração do OpenTelemetry para NestJS: trace-id/correlation-id
propagados via AsyncLocalStorage, logger correlacionado (console + OTLP),
`@Span`/`@Measure` decorators, `MetricsService`, interceptors HTTP e
mensageria (Kafka) configuráveis via `TelemetryModule.forRoot()`, e
exportação configurável de logs/traces/métricas pro OTel Collector — os
três sinais (logs, traces, métricas) têm abstração própria na SDK.
**A SDK não loga nada** — só instrumenta (trace/correlation-id/métrica);
logar é responsabilidade da aplicação (ver decisão 16). A `sandbox/`
demonstra a SDK em requests HTTP, consumo de eventos Kafka e jobs
agendados (`@nestjs/schedule`) — os três formatos de execução que geram
contexto de trace de formas diferentes (herdado, propagado via headers,
ou sintético/raiz nova).

**`src/` não tem comentário narrativo nenhum — só JSDoc de assinatura
(`@param`/`@returns`) e um resumo curto por símbolo exportado.** Isso foi
deliberado (ver decisão 20): todo o "porquê" de uma decisão não-óbvia mora
AQUI, neste arquivo, não no código. Se você for mexer em `src/` e sentir
falta de contexto que um comentário deveria ter, é porque ele está numa
das decisões numeradas abaixo — procure antes de perguntar, e adicione uma
entrada nova se descobrir algo que não estava documentado.

## Estrutura

- `src/` — SDK (publicada como pacote `@snokedll/otel-for-nestjs`)
- `test/` — suíte Vitest, espelhando a estrutura de `src/` (nunca
  co-localizada com o código-fonte — mantém `dist/` = só o publicável)
  - `test/security/` — testes estilo pentest (prototype pollution, DoS por
    recursão, header injection, type confusion, W3C traceparent malformado)
  - `test/support/` — mocks reusáveis do `@opentelemetry/api` (tracer,
    meter, span fakes) e o setup global (`AsyncLocalStorageContextManager`
    real, necessário pra `runWithRemoteParent` funcionar em teste)
- `sandbox/` — app NestJS de exemplo, pra rodar a SDK localmente e testar
  na mão (não é suíte de teste automatizado — isso é `test/`)
  - `src/invoices/` — HTTP (`invoices.controller.ts`), publisher/consumer
    Kafka (`invoices-events.publisher.ts`/`invoices-events.controller.ts`)
    e cron (`invoices.scheduler.ts`) sobre o mesmo domínio de faturas
  - `src/common/` — `HttpLoggingInterceptor`/`MessageLoggingInterceptor`:
    exemplo de logging de ciclo de vida request/evento por conta da
    APLICAÇÃO (a SDK não loga nada, ver decisão 16)
  - `docker/` — stack de observabilidade (Collector + Tempo + Loki +
    Prometheus + Grafana + Kafka) — mora dentro de `sandbox/` porque só
    existe pra rodar a sandbox, não é infra da SDK em si

## Decisões de arquitetura (não óbvias — não refazer sem motivo)

1. **`traceId` sempre no formato W3C** (32 hex chars), nunca UUID v4. Usa
   `RandomIdGenerator` do `@opentelemetry/sdk-trace-base` como fallback,
   pra ficar idêntico ao formato de um span real — mesmo formato,
   independente da origem.

2. **`TraceContextManager.getTraceId()`/`getSpanId()` sempre checam o span
   ativo do OTel primeiro** (`trace.getActiveSpan()`), com fallback pro
   contexto salvo em AsyncLocalStorage, e só por último geram um ID
   sintético. Sempre valide com `isSpanContextValid()` antes de usar o
   spanContext — um tracer no-op (sem provider real registrado) retorna
   traceId/spanId zerados (sentinel inválido da spec), não `undefined`.

3. **SUPERSEDIDA pela decisão 31 — mantida aqui só por contexto histórico.**
   Achávamos que `initializeTelemetry()` precisava rodar antes de qualquer
   import de http/express/kafkajs/amqplib/pg, exigindo um `sandbox/tracing.ts`
   separado carregado via `node --require`. Verificação empírica (decisão
   31) mostrou que isso era mais rígido do que o necessário: chamar
   `initializeTelemetry()` dentro de `TelemetryModule.forRoot()` — ou seja,
   no momento em que o decorator `@Module()` do `AppModule` é avaliado, não
   antes de tudo — já é cedo o suficiente na prática, porque a auto-
   instrumentação da maioria das libs (incluindo `http` nativo e `kafkajs`)
   faz PATCH DE PROTÓTIPO/objeto compartilhado, que funciona mesmo se o
   módulo já tinha sido `require`'d antes, desde que o patch aconteça antes
   do método real ser INVOCADO (criar servidor, conectar produtor/consumer)
   — não antes do `require()`. O que continua verdade: chamar dentro de um
   lifecycle hook do Nest (`onModuleInit`) SERIA tarde demais, porque `app.listen()`
   e a conexão de clients (Kafka etc.) já teriam acontecido antes de
   `onModuleInit` rodar. `forRoot()` executa a tempo porque roda como efeito
   colateral da AVALIAÇÃO do decorator, não de um lifecycle hook.

4. **Sinais desabilitados (`traces: {enabled: false}` etc.) SEMPRE passam
   array vazio explícito** (`spanProcessors: []`) pro `NodeSDK`, nunca
   omitem a chave. Omitir faz o SDK cair num fallback de variável de
   ambiente que reativa exportação pra `localhost:4318` de qualquer jeito
   — bug real, já mordeu a gente uma vez.

5. **Módulo da SDK compila pra CommonJS** (`module: "commonjs"` no
   tsconfig), não ESM. Com `module: "ESNext"` + `moduleResolution: "bundler"`,
   os imports relativos saem sem extensão `.js`, e o Node quebra em
   runtime (`ERR_MODULE_NOT_FOUND`) porque ninguém bundla essa lib depois.

6. **Dockerfile usa `npm pack` pra empacotar a SDK antes de instalar na
   sandbox**, não `file:..` direto. `file:..` cria um symlink pra pasta
   original — que não existe no estágio final da imagem (só copiamos
   `dist/`), quebrando a resolução de `@opentelemetry/*`.

7. **Protocolo OTLP: `http/protobuf` é o default**, não `http/json`. São
   pacotes NPM separados por protocolo (`exporter-*-otlp-http` = JSON,
   `exporter-*-otlp-proto` = protobuf), não uma opção de config no mesmo
   exporter.

8. **Ecossistema OpenTelemetry NÃO versiona tudo junto.** `sdk-node`,
   `instrumentation-*`, `exporter-*` seguem a família `0.x`; `sdk-trace-node`,
   `sdk-metrics`, `resources`, `core` já são `2.x` estáveis. Sempre
   verificar `npm view <pacote> version` antes de fixar uma versão — várias
   vezes nessa conversa uma versão "lógica" simplesmente não existia.

9. **Imagens Docker de infra também precisam de versão fixa, não só pacotes
   npm.** `grafana/tempo:latest` quebrou (`field compactor not found in
   type app.Config`) porque `latest` passou a apontar pro Tempo 3.0, que
   removeu o bloco `compactor:` e trocou compaction por um sistema
   baseado em jobs (`backend_scheduler`/`backend_worker`, pensado pra
   storage em object store, não pro single-binary local). Fixamos em
   `grafana/tempo:2.10.0` (último 2.x antes do salto). Mesma lição da
   decisão 8, agora pra `docker-compose.yml`: nunca usar `:latest` em infra
   que muda schema entre versões sem aviso.

10. **`TraceLogger` é o único logger da SDK e implementa `LoggerService`
    do `@nestjs/common`.** Isso permite `app.useLogger(new TraceLogger())`
    em `main.ts` (com `bufferLogs: true` no `NestFactory.create`), fazendo
    até os logs internos do Nest (bootstrap, `RoutesResolver`,
    `ExceptionsHandler` etc.) saírem correlacionados e irem pro OTel — não
    só os logs que a aplicação emite explicitamente. Detalhe de
    compatibilidade: os métodos seguem a convenção de chamada do Nest
    (`log/warn/debug/verbose/fatal(message, ...optionalParams)`, onde a
    última string em `optionalParams` vira `context`, não metadata) em vez
    da convenção da própria SDK (`metadata` como objeto). `error()`
    diferencia stack trace cru de string de contexto via regex
    (`STACK_TRACE_PATTERN`), porque o Nest chama `error(msg, stack,
    context?)` internamente. `info()` continua sendo o método canônico
    usado pelo resto da SDK; `log()` é só o alias exigido pela interface.
    Bônus não-óbvio: como `new Logger(ctx)` do `@nestjs/common` delega pro
    `Logger.staticInstanceRef` (setado internamente por `useLogger()`),
    qualquer código que use o `Logger` puro do Nest em vez de `TraceLogger`
    cai na mesma pipeline (pino + OTel) de qualquer jeito — rede de
    segurança, não motivo pra recomendar `Logger` puro como padrão.

11. **`MessageTraceInterceptor` (Kafka) está construído** — simétrico ao
    `HttpTraceInterceptor`, mas NÃO é registrado globalmente pelo
    `TelemetryModule` (aplique via `@UseInterceptors(...)` no controller
    Kafka). Dois detalhes que já causaram bug real nessa implementação:
    - **`HttpTraceInterceptor` agora tem guarda `context.getType() !==
      'http'`** — necessário porque numa app híbrida (HTTP + microservice
      no mesmo processo, via `connectMicroservice()`), um interceptor
      global (`APP_INTERCEPTOR`) roda pra AMBOS os tipos de contexto.
      `switchToHttp().getRequest()` num contexto RPC não lança, só devolve
      o payload cru sem `.headers`, quebrando `getHeader()` silenciosamente
      até a primeira mensagem chegar.
    - **`runWithRemoteParent` precisa envolver o código SÍNCRONO que chama
      `next.handle().subscribe()`, não a construção do `Observable`.**
      `new Observable(subscriberFn)` não executa `subscriberFn`
      imediatamente — só quando algo chama `.subscribe()`, o que acontece
      DEPOIS que `intercept()` já retornou, fora do escopo síncrono de
      `otelContext.with()`. Errar isso não quebra a correlação de log (o
      traceId já foi capturado como string antes disso), mas quebra o
      parenting de qualquer `@Span` aberto dentro do handler — ele vira
      uma raiz de trace nova, desconectada do producer. Ver o comentário
      em `message-trace.interceptor.ts` pro código certo.

12. **Kafka: tópico precisa ser criado explicitamente no bootstrap antes
    de conectar consumer/producer** (`ensureKafkaTopics()` em
    `sandbox/main.ts`, via `kafkajs`'s `admin().createTopics()`).
    Depender de auto-criação (`auto.create.topics.enable`) quebra o boot:
    a primeira metadata request pro tópico ainda inexistente DISPARA a
    criação mas o broker responde `UNKNOWN_TOPIC_OR_PARTITION` nessa MESMA
    request (erro transiente esperado pela spec) — e isso sobe como
    exceção não tratada no `@nestjs/microservices`, derrubando o processo.
    `createTopics()` não lança se o tópico já existir.

13. **Broker Kafka local: `apache/kafka:4.1.0` em modo KRaft combinado**
    (broker+controller no mesmo processo, sem Zookeeper — ver decisão 9
    sobre nunca usar `:latest`). `KAFKA_ADVERTISED_LISTENERS` aponta pro
    hostname do container (`kafka:9092`), não `localhost` — é esse
    endereço que os clients recebem do broker depois do bootstrap inicial,
    e quem conecta é outro container (`billing-simulation`), não o host.

14. **Tarefas agendadas usam `@nestjs/schedule`, não Bull/Redis.** Job de
    cron roda em processo, sem infra nova. É também o caso de teste mais
    limpo pro fallback de traceId sintético (decisão 2): sem request HTTP
    por trás, `@Span` no método agendado abre uma raiz de trace nova a
    cada execução — cada rodada do cron vira sua própria trace isolada,
    sem relação com nenhuma requisição.

15. **`MetricsService` está construído** (`counter`/`histogram`/
    `upDownCounter`/`observableGauge`, cacheados por nome, sobre o Meter
    `@snokedll/otel-for-nestjs`) + decorator `@Measure` (paralelo ao `@Span`, grava
    `<nome>.calls` e `<nome>.duration`). `HttpTraceInterceptor` grava
    métricas RED (`http.server.requests`, `http.server.request.duration`)
    e `MessageTraceInterceptor` grava métricas de mensageria
    (`messaging.kafka.messages_consumed`, `.processing.duration`).
    **Regra de ouro: atributo de métrica é dimensão de baixa cardinalidade
    only** — `route` usa `Classe.metodo` (via `context.getClass().name` +
    `context.getHandler().name`), NUNCA a URL crua (`/invoices/inv_x7f2q1`
    tem o ID no meio — uma série temporal nova por fatura). Nunca
    `trace_id`/`correlation_id`/`invoice_id` como atributo — isso é log ou
    trace, não métrica; correlação métrica↔trace é via exemplar, não
    atributo.

    **Bug real pego nessa implementação:** `metrics.getMeter()` (API do
    OTel) NÃO tem proxy retroativo como `trace.getTracer()`/`logs.getLogger()`
    parecem ter — ele resolve o `MeterProvider` global NO MOMENTO exato da
    chamada (`getMeterProvider().getMeter(...)`), e se isso acontecer antes
    de `sdk.start()` registrar o provider real, devolve um `NoopMeter`
    congelado PRA SEMPRE (sem re-bind depois). `MetricsService` tinha
    `private static readonly meter = metrics.getMeter(...)` como campo de
    classe — e como `tracing.ts` faz `import { initializeTelemetry } from
    '@snokedll/otel-for-nestjs'`, isso carrega o barrel `index.ts` inteiro
    (`metrics.service.ts` incluso) ANTES da própria chamada a
    `initializeTelemetry()` executar. Resultado: todo instrumento criado
    por `MetricsService` era um no-op silencioso — sem erro, sem log, só
    métricas que nunca apareciam no Prometheus. Fix: `getMeter()` chamado
    de novo a cada `counter()`/`histogram()`/etc., nunca cacheado num
    campo estático. Regra geral pra próxima vez que algo desse tipo for
    adicionado: qualquer chamada `trace.*`/`logs.*`/`metrics.*` do
    `@opentelemetry/api` só é segura como campo `static`/top-level se
    NINGUÉM no grafo de imports carregar aquele módulo antes de
    `sdk.start()` — o que é frágil o bastante pra nunca fazer isso, ponto.

16. **A SDK não loga nada — nem "requisição recebida", nem "mensagem
    processada".** `HttpTraceInterceptor`/`MessageTraceInterceptor` só
    cuidam de trace/correlation-id/métrica; decidir SE e O QUE logar
    (inclusive achar `/health` "ruído") é decisão de produto, não de
    infraestrutura de telemetria — a SDK só garante que QUALQUER log que a
    app emitir saia correlacionado (via `TraceContextManager`), nunca
    decide por ela. `TelemetryModule.forRoot()` virou dynamic module com 3
    opções configuráveis:
    - **`correlationIdSources`**: array de `{ from: 'header'|'body', key
      }`, testado em ordem — primeiro que achar um valor vence. Default
      mantém o comportamento antigo (headers `x-correlation-id`/
      `correlation-id`/`correlationId`). `from: 'body'` usa dot-notation
      (`'data.correlationId'`) contra o corpo já desserializado (funciona
      pra POST/PUT HTTP e pra eventos Kafka).
    - **`ignoreRoutes`**: array de `string | RegExp` — rota batendo pula
      COMPLETAMENTE `HttpTraceInterceptor` (nem trace, nem correlation,
      nem métrica).
    - **`ignoreEvents`**: array de `{ body?, headers? }` — correspondência
      parcial/recursiva contra o evento. Ex: `[{ body: { name:
      'HEALTH_CHECK' } }]`.
    - **Pegadinha real**: `ignoreRoutes`/`ignoreEvents` só pulam a
      instrumentação DO PRÓPRIO interceptor — não cortam a cadeia.
      `@UseInterceptors(MessageTraceInterceptor, MessageLoggingInterceptor)`
      com o primeiro retornando `next.handle()` cedo ainda invoca o
      segundo normalmente (é assim que `next.handle()` funciona: ele É o
      resto da cadeia). Se a app tem um interceptor de log próprio depois,
      ele precisa aplicar o MESMO filtro de novo se quiser não logar o
      mesmo evento — só descobri isso testando de verdade (publiquei um
      evento `{name: 'HEALTH_CHECK'}` manualmente e vi que a métrica não
      contou, mas o log de exemplo da simulação continuou disparando, até
      eu replicar o filtro em `MessageLoggingInterceptor`).
    - Injeção via `TELEMETRY_MODULE_OPTIONS` (token exportado) — tanto
      `HttpTraceInterceptor` (registrado globalmente pelo `forRoot()`)
      quanto `MessageTraceInterceptor` (opt-in por controller) leem a
      MESMA config, porque `TelemetryModule` é `@Global()`.

17. **`experimentalDecorators`/`emitDecoratorMetadata` habilitados no
    tsconfig da SDK** — precisou pra usar `@Inject()` (construtor) nos
    interceptors. TS 6.x usa decorators nativos (stage 3) por padrão, que
    NÃO suportam decorator de parâmetro (não existe no proposal
    padronizado) nem são type-compatíveis com decorator de campo no
    formato que o Nest usa (`PropertyDecorator`/`ParameterDecorator` são
    tipos do modelo legado). `@Injectable()`/`@Module()` (decorators de
    classe) já funcionavam sem essa flag por acaso — só decorator de
    parâmetro/campo quebra. `@Span`/`@Measure` não são afetados: são
    funções comuns que RETORNAM um decorator pro código consumidor, não
    usam sintaxe de decorator dentro da própria SDK.

18. **Pacote renomeado pra `@snokedll/otel-for-nestjs`** (era
    `otel-for-nestjs`). Nome do REPO/pasta e título do README/claude.md
    continuam `otel-for-nestjs` — só o nome do pacote npm mudou. Os 3
    instrumentation scope names (`trace.getTracer(...)`,
    `logs.getLogger(...)`, `metrics.getMeter(...)`) foram atualizados junto,
    por consistência (scope name = nome da lib que gerou o dado, pela spec
    do OTel). Pegadinha no `sandbox/Dockerfile`: `npm pack` de um
    pacote com escopo (`@scope/nome`) gera tarball `scope-nome-versão.tgz`
    (sem `@`, `/` vira `-`) — `snokedll-otel-for-nestjs-1.0.0.tgz`, não
    `otel-for-nestjs-1.0.0.tgz`. `npm pkg set` com chave de dependência
    com escopo precisa da forma de argumento único com `=`:
    `npm pkg set 'dependencies.@scope/nome=file:...'` (a forma
    `dependencies.@scope/nome="valor"` com dois argumentos separados
    também funciona, mas o `=` embutido evita ambiguidade de parsing).

19. **`@Span`/`@Measure` funcionam em QUALQUER ordem relativa aos
    decorators do Nest** (`@Get`, `@Post`, `@EventPattern`, `@Cron`, etc.)
    — isso não era verdade antes e foi corrigido de propósito, não é
    acidente. Causa raiz: decorators do Nest gravam metadata direto na
    função que estiver em `descriptor.value` no momento em que rodam
    (`Reflect.defineMetadata(chave, valor, descriptor.value)`), e
    decorators aplicam de baixo pra cima. Como `@Span`/`@Measure`
    SUBSTITUEM `descriptor.value` por um wrapper novo (pra poder envolver a
    chamada original), se um decorator do Nest rodasse ANTES (por estar
    mais embaixo no código), a metadata gravada na função antiga ficava
    órfã quando o wrapper a substituía — `RoutesResolver` não achava a
    rota, sem erro nenhum, 404 silencioso só por causa da ordem em que os
    decorators foram escritos. Fix: `copyMethodMetadata()`
    (`src/decorators/copy-method-metadata.ts`) — chamado sempre que
    `@Span`/`@Measure` cria o wrapper, copia via `Reflect.getMetadataKeys`
    TODA metadata que a função original já tivesse pro wrapper, antes de
    descartá-la. Cobre qualquer chave de metadata (não só `PATH_METADATA`
    — guards, roles, `EVENT_PATTERN_METADATA`, o que for), então não é uma
    correção específica pro caso do `@Get`, é geral. Nenhuma dependência
    nova: usa `Reflect.getMetadataKeys`/`getMetadata`/`defineMetadata` via
    cast de tipo local (a SDK não importa `reflect-metadata` diretamente —
    esses métodos só existem em runtime se alguém no processo já importou,
    o que toda app NestJS já faz como primeiro import do `main.ts`; se não
    existir, é no-op seguro).

20. **`src/` foi reescrita inteira pra tirar todo comentário narrativo,
    deixando só JSDoc de assinatura** (`@param`/`@returns`/um resumo curto),
    e aplicando padrões de projeto onde reduziam duplicação de verdade —
    não só por estética:
    - **Template Method** (`src/interceptors/base-trace.interceptor.ts`,
      `BaseTraceInterceptor`): `HttpTraceInterceptor`/`MessageTraceInterceptor`
      compartilhavam quase todo o fluxo (checar ignore, extrair
      correlation-id, criar/rodar `TraceContext`, gravar métrica no
      settle) — só a extração por transporte mudava. A base implementa o
      fluxo UMA vez (inclusive a pegadinha do `runWithRemoteParent` tendo
      que envolver o `next.handle().subscribe()` síncrono — ver decisão
      11); subclasses só implementam os hooks (`extractSignalContext`,
      `shouldIgnore`, `extractCorrelationId`, `extractRemoteParent`,
      `beforeRun`, `recordOutcome`).
    - **Chain of Responsibility** (`extractCorrelationId` em
      `correlation-id-extractor.ts`): testa `sources` em ordem, primeiro
      resolver que devolver valor vence.
    - **Strategy** (`EXPORTER_FACTORIES` em `initialize-telemetry.ts`):
      tabela `protocolo → {traces, logs, metrics}` factory, em vez de
      `if/else` espalhado escolhendo exporter JSON vs protobuf.
    - **Factory + cache** (`InstrumentCache` em `metrics.service.ts`):
      `counter`/`histogram`/`upDownCounter` eram três blocos idênticos de
      "pega do Map ou cria" — virou uma classe genérica reusada três vezes.
    - `@Span`/`@Measure` compartilham `settleSyncOrAsync()`
      (`settle-sync-or-async.ts`) pro dance de sync/throw/Promise/reject
      idêntico entre os dois, e `resolveDefaultName`/`assertStringPropertyKey`
      (`decorator-utils.ts`) pro parsing de opções.
    - O que NÃO foi unificado, de propósito: `@Span` precisa que a
      chamada original aconteça DENTRO do callback de
      `tracer.startActiveSpan()` (senão o span não fica ativo pros filhos);
      `@Measure` não tem essa exigência. Forçar os dois num wrapper
      genérico único teria reintroduzido a MESMA classe de bug da decisão
      11 (contexto ativo só durante o escopo síncrono certo) — correção >
      pureza de padrão.

21. **Toda a suíte de testes usa Vitest, vive em `test/` (nunca
    co-localizada com `src/`), e roda com `AsyncLocalStorageContextManager`
    real registrado** (`test/support/setup.ts`, via `setupFiles` no
    `vitest.config.mts`) — sem isso, `context.active()` do
    `@opentelemetry/api` cai no `NoopContextManager` (nenhum SDK real foi
    inicializado no processo de teste), que ignora o contexto passado pra
    `context.with()` completamente; `runWithRemoteParent` "funcionava" nos
    testes mas não fazia nada. `MetricsService`/`trace.getTracer`/
    `logs.getLogger` são mockados via `vi.spyOn` retornando fakes
    (`test/support/otel-mocks.ts`), não uma instância real de
    `MeterProvider`/`TracerProvider` — testamos a lógica DA SDK, não o SDK
    do OTel. Pegadinha: `MetricsService` cacheia instrumento por NOME num
    Map de módulo — o mock do meter precisa estar armado ANTES do primeiro
    `new HttpTraceInterceptor(...)`/`new MessageTraceInterceptor(...)` do
    arquivo de teste, porque chamadas seguintes com o mesmo nome reusam o
    instrumento já cacheado (não chamam `getMeter()` de novo). Os testes
    desses dois interceptors resolvem isso com um `beforeAll` que constrói
    UMA instância e limpam só o histórico de chamadas do mock (`mockClear`)
    em `beforeEach`, em vez de recriar tudo a cada teste.

22. **Suíte de segurança dedicada** (`test/security/security.spec.ts`) —
    achados reais, não hipotéticos, corrigidos durante a escrita dos
    próprios testes:
    - **Header injection**: `x-correlation-id` refletido de volta na
      resposta HTTP podia vir direto de input do atacante (header ou
      corpo). `HttpTraceInterceptor.beforeRun()` agora rejeita valores com
      `\r`/`\n` (`UNSAFE_HEADER_VALUE_PATTERN`) antes de chamar
      `setHeader()` — não depende só da proteção nativa do
      `http.ServerResponse` do Node (que existe, mas não é garantida em
      todo adapter/versão).
    - **Fail-closed em `isRouteIgnored`**: um `pattern` malformado em
      `ignoreRoutes` (nem `string` nem `RegExp` — config dinâmica/carregada
      de fora pode ter erro de digitação) fazia `pattern.test(...)`
      explodir, derrubando TODA requisição. Agora `matchesPattern()` só
      chama `.test()` se `pattern instanceof RegExp`; qualquer outra coisa
      nunca casa (não trava, não vira "ignora tudo" por acidente).
    - **Prototype pollution**: `resolveBodyPath` (correlation-id) rejeita
      segmentos `__proto__`/`constructor`/`prototype` e só lê own
      properties (`hasOwnProperty`) — path de corpo de requisição/evento é
      input externo.
    - **DoS por recursão**: tanto `resolveBodyPath` quanto
      `deepPartialMatch` (ignore-matchers) têm profundidade de recursão
      limitada pela estrutura do CONFIG (a `key`/`expected` que a
      aplicação escreveu), nunca pelo `body`/`actual` (controlado por
      quem chama a API) — um payload com 50 mil níveis de aninhamento
      resolve em <100ms porque a recursão nem entra nele.
    - `traceparent` malformado/vazio/gigante nunca lança, nunca
      reparenta errado — só cai no fallback já coberto pela decisão 2.

23. **SDK preparada pra publicação no NPM**: `LICENSE` (MIT, faltava),
    `.gitignore` na raiz cobrindo `node_modules`/`dist`/`coverage` de
    AMBOS `src/` e `sandbox/`, `package.json` com `files: ["dist"]`
    (já existia, validado com `npm pack --dry-run` — pacote final tem só
    `dist/` + `LICENSE` + `README.md` + `package.json`, 39 kB). `test/`,
    `sandbox/`, configs (`tsconfig.json`, `vitest.config.mts`) nunca vão
    pro tarball porque não estão em `files` — não precisou de
    `.npmignore` separado, `files` já é a allowlist definitiva.

24. **Compatibilidade atestada empiricamente, não só declarada.** Copiei
    `src/`+`test/`+config (sem `node_modules`) pra containers `node:X-alpine`
    isolados e rodei `npm install && npm run build && npm test` de
    verdade:
    - **Node 18/20/22/24**: os 4 rodam o BUILD (`dist/`) sem problema —
      testado via `node -e` chamando `TraceLogger`/`resolveTelemetryConfig`/
      `extractCorrelationId` direto no output compilado. Node 18
      especificamente falha em rodar a suíte Vitest (Vitest 4 usa
      `rolldown`, que depende de `node:util`'s `styleText`, só existe a
      partir do Node 20.12) — isso é exigência do TOOLING de teste, não do
      código publicado. `engines.node` continua fixo em `>=22.0.0` de
      propósito: Node 18 e 20 já estão EOL em 2026, não por incompatibilidade
      técnica real.
    - **NestJS 9.4.3 / 10.4.22 / 11.1.29** (última patch de cada major, o
      range inteiro do peerDependency): `tsc --noEmit` limpo e as 185
      asserções da suíte passam nos três, todos no Node 22.

25. **`@Span`/`@Measure` precisam restaurar `Function.prototype.name` no
    wrapper — a mesma classe de bug da decisão 19, achada durante a
    validação end-to-end final, não pelos testes unitários** (os testes de
    `HttpTraceInterceptor` mockam `getHandler()`, então nunca exercitam um
    handler de verdade decorado com `@Span`). Causa: `const wrapped =
    function () {...}` tem `wrapped.name` inferido pra `"wrapped"` via
    NamedEvaluation do ECMAScript (uma atribuição de propriedade solta,
    `descriptor.value = function () {...}`, NÃO sofre essa inferência — o
    código antes da reescrita usava essa forma por acidente, nunca
    documentado). Como `HttpTraceInterceptor` monta o label de métrica
    `route` a partir de `context.getHandler().name`, toda rota decorada
    com `@Span`/`@Measure` reportava `Controller.wrapped` em vez de
    `Controller.nomeReal` — só apareceu rodando a stack de verdade
    (`docker compose`) e olhando o `/metrics` real, nenhum teste com mock
    pegava. Fix: `preserveFunctionName()` (`decorator-utils.ts`) — usa
    `Object.defineProperty(wrapper, 'name', { value: source.name,
    configurable: true })` depois de criar o wrapper, em ambos os
    decorators. Lição: qualquer decorator de método que troca
    `descriptor.value` precisa preservar TANTO reflect-metadata (decisão
    19) QUANTO `Function.prototype.name` — os dois são "coisas que o Nest
    lê da função final", não só metadata explícita.

26. **Configuração unificada num único `TelemetryConfig`, não mais dois
    tipos paralelos.** Existiam `TelemetryConfig` (pra `initializeTelemetry()`)
    e `TelemetryModuleOptions` (pra `TelemetryModule.forRoot()`) — dois
    tipos quase idênticos, cada um com seu próprio "resolve" e seus
    próprios defaults, fácil de deixar dessincronizados. Nesta rodada,
    unificamos só o TIPO (achávamos, na época, que a restrição física da
    decisão 3 impedia unificar também a CHAMADA — a decisão 31 mostrou que
    não era bem assim, e eliminou até o segundo ponto de entrada). O que foi
    feito aqui: `TelemetryConfig` (`src/config/telemetry-config.ts`) virou a
    única interface, com `resolveTelemetryConfig()` como único "resolve".
    `TELEMETRY_MODULE_OPTIONS`/`ResolvedTelemetryModuleOptions`
    (arquivo `telemetry-module-options.ts`) foram removidos; o token agora é
    `TELEMETRY_CONFIG` (`nestjs/telemetry.tokens.ts`), injetado tanto em
    `HttpTraceInterceptor` quanto em `MessageTraceInterceptor`. Efeito
    colateral deliberado: `TelemetryModule.forRoot()` não aceita mais
    chamada sem argumento — `serviceName` é obrigatório em `TelemetryConfig`,
    então só faz sentido registrar o módulo depois de já ter esse valor em
    mãos (o mesmo valor que `initializeTelemetry()` já usou).

27. **`MetricsService` ganhou um terceiro parâmetro opcional —
    `attributes` — pra atributos fixos por instrumento, sem virar um
    wrapper que perde a identidade OTel do instrumento.** O pedido era
    "vincular métricas a um objeto de contexto". A tentação errada seria
    aceitar atributos arbitrários por CHAMADA sem nenhum aviso — isso
    reabriria o problema de cardinalidade que a decisão 15 já resolveu (um
    ID único por chamada vira uma série temporal nova). A solução: os
    atributos ficam presos ao INSTRUMENTO na hora da criação
    (`MetricsService.counter(name, { attributes: { module: 'invoices' } })`),
    não na hora do `.add()`/`.record()` — continuam sendo um valor fixo,
    de baixa cardinalidade, só que agora reutilizável em toda métrica
    daquele instrumento sem repetir o objeto em cada call site. Implementação:
    `bindAddInstrument`/`bindHistogram` (`metrics.service.ts`) envolvem o
    instrumento OTel real (ainda cacheado por nome, ver decisão original de
    `InstrumentCache`) numa função fina que faz merge (`{ ...base,
    ...perCall }`, per-call ganha em colisão de chave) antes de repassar pro
    `.add()`/`.record()` de verdade — o instrumento cru nunca é substituído
    por um objeto customizado sem essas duas funções, então o resto da API
    (exemplars, cache) continua intacto. `observableGauge` ficou de fora do
    cache por nome — sempre cria um instrumento novo — porque, diferente de
    counter/histogram, seu callback é parte da identidade da chamada; cachear
    por nome faria uma segunda chamada com um callback diferente registrar
    DOIS callbacks no mesmo instrumento em vez de um, silenciosamente.

28. **`environment` é um resource attribute do NodeSDK
    (`deployment.environment.name`), não um atributo manual repetido em
    cada span/log/métrica.** Confirmado por leitura do código-fonte de
    `@opentelemetry/sdk-node` (`this._resource = configuration.resource ??
    defaultResource(); ...this._resource.merge(resourceFromAttributes({
    [SEMRESATTRS_SERVICE_NAME]: serviceName }))`): um `Resource` passado em
    `NodeSDK({ resource })` é automaticamente MESCLADO com o resource
    derivado de `serviceName`, e um `Resource` se propaga pra TODOS os
    providers (traces, logs, métricas) que o SDK cria — não precisa setar o
    atributo em três lugares. `buildResource()` (`initialize-telemetry.ts`)
    só constrói esse `Resource` (via `resourceFromAttributes` +
    `ATTR_DEPLOYMENT_ENVIRONMENT_NAME`, a constante estável de
    `@opentelemetry/semantic-conventions@1.43+`) quando `environment` foi
    configurado; `undefined` caso contrário — `NodeSDK` trata
    `resource: undefined` com o mesmo fallback de sempre (`??
    defaultResource()`), então não configurar `environment` continua
    exatamente como era antes desta mudança. Pegadinha resolvida à parte:
    resource attributes chegam de graça em traces/logs, mas o exporter
    Prometheus do Collector IGNORA resource attributes por padrão — só viram
    labels com `resource_to_telemetry_conversion: enabled: true` no exporter
    `prometheus` (`sandbox/docker/otel-collector-config.yaml`), sem isso
    `environment`/`service.name` some das métricas mesmo estando no payload
    OTLP recebido pelo Collector. Validado end-to-end via docker-compose:
    `deployment_environment_name="sandbox"` aparece como label em TODA
    métrica Prometheus, incluindo as nativas de auto-instrumentação.

29. **`service.name` ser o critério de busca principal no Grafana é
    comportamento do LOKI/Tempo (stream labels), não uma omissão da SDK —
    mas a SDK tinha, de fato, uma lacuna real: correlation_id nunca virava
    atributo de span, então não dava pra buscar traces por ele via
    TraceQL.** Investigação, não achado de bug: Loki promove `service.name`
    a stream label indexado por convenção (via `resource_to_telemetry_conversion`
    equivalente pro pipeline de logs, já configurado antes desta rodada);
    trace_id JÁ é buscável (é a chave primária do Tempo, não precisa de
    nada extra da SDK) e aparece como `derivedField` no datasource do Loki
    (clica no log, abre o trace). O que faltava de verdade: correlation_id
    nunca era setado como ATRIBUTO DE SPAN, então o TraceQL `{
    span.app.correlation_id = "..." }` simplesmente não achava nada — só
    existia nos logs (via `TraceLogger`, decisão anterior) e no header de
    resposta HTTP. Cogitei e REJEITEI promover trace_id/correlation_id a
    label indexado no Loki pra "virar critério de busca" — seria a MESMA
    classe de erro da decisão 15 (cardinalidade), agora em labels de log em
    vez de atributos de métrica: um valor único por request como label
    indexado explode a cardinalidade de streams do Loki. A correção real:
    `TraceContextManager.createContext()` agora tageia o span ATIVO com
    `app.correlation_id` (constante `CORRELATION_ID_ATTRIBUTE`,
    compartilhada com `TraceLogger` — mesma chave nos dois sinais) sempre
    que um correlationId está presente — efeito colateral desta função, que
    já rodava em todo request/evento processado pelos interceptors da SDK,
    sem precisar de nenhum hook novo. Safe-by-construction: `trace.getActiveSpan()`
    pode retornar `undefined` (sem span ativo) ou um `NonRecordingSpan`
    (contexto de parent remoto via `runWithRemoteParent`, decisão 11) cujo
    `setAttribute()` é um no-op da própria API — nenhum dos dois casos
    lança exceção, então a chamada é sempre segura mesmo fora de um
    request HTTP. Validado via TraceQL real (`{ span.app.correlation_id =
    "..." }` retornando o trace certo) no docker-compose.

30. **Continuidade de trace através de QUALQUER gap assíncrono
    (fila, `setTimeout`, agendamento) via `captureTraceCarrier()` +
    `runWithTraceCarrier()` — sem a SDK saber nada sobre Bull, RabbitMQ,
    Kafka ou qualquer outro broker.** O pedido explícito era "não amarrar a
    uma tecnologia de fila específica". A chave pra isso: o par de funções
    não lê nem escreve em headers de transporte nenhum — `TraceCarrier` é
    só um objeto plano (`{ traceparent?, tracestate?, correlationId? }`),
    JSON-serializável, que o CHAMADOR decide onde guardar (um campo a mais
    no payload do job, uma coluna extra numa tabela de agendamento, o que
    for) — a SDK nunca inspeciona a fila em si, só produz/consome esse
    objeto. `captureTraceCarrier()` empacota `injectW3CTraceParent()` (já
    existente, decisão 11) + o correlationId corrente do
    `TraceContextManager`; chamado ainda DENTRO do request/evento que vai
    disparar o processamento assíncrono. `runWithTraceCarrier()`, do lado
    de quem processa (minutos/dias depois, outro processo até), reabre o
    MESMO trace id como um span FILHO de verdade — não um mero placeholder
    de contexto como `runWithRemoteParent()` sozinho faria: ele chama
    `tracer.startActiveSpan()` (mesmo padrão do `@Span()`, decisão de
    Template Method reaproveitada, inclusive reusando `settleSyncOrAsync`
    pra sync/async/erro de forma uniforme) DENTRO do contexto do parent
    remoto, então o resultado é um span de verdade, exportado, visível na
    árvore do Tempo — não só uma correlação "de nome" nos logs. Efeito:
    dá pra literalmente ver, na UI do Tempo, o span HTTP original com um
    span filho `invoice.delayed-processing` iniciado 1 segundo depois,
    mesmo trace id, ambos com `app.correlation_id` (decisão 29). Fail-open
    por design em `carrier` ausente/inválido (`traceparent` malformado,
    `undefined`, objeto vazio): `fn` roda igual, só como raiz de um trace
    novo — nunca lança, nunca bloqueia o processamento por causa de um
    carrier corrompido em trânsito. Demo em `sandbox/invoices.service.ts`
    (`scheduleDelayedProcessing`) usa `setTimeout` deliberadamente — é o
    mecanismo assíncrono mais simples que existe, exatamente pra deixar
    claro que o mesmo padrão vale pra um `queue.add()` do Bull, um
    `channel.publish()` do RabbitMQ ou um `producer.send()` do Kafka, sem
    trocar uma linha da SDK.

31. **`tracing.ts`/`--require` eliminado — `TelemetryModule.forRoot()` agora
    também chama `initializeTelemetry()`, um único ponto de entrada pra SDK
    inteira — verificado empiricamente, não só por dedução.** A decisão 3
    dizia que `initializeTelemetry()` precisava rodar antes de QUALQUER
    `import`/`require` de http/express/kafkajs — sabedoria convencional do
    ecossistema OTel JS (é literalmente a primeira instrução dos guias
    oficiais). Em vez de confiar nisso cegamente, testamos: movemos a
    chamada pra dentro de `TelemetryModule.forRoot()` (que roda quando o
    decorator `@Module()` do `AppModule` é avaliado — ou seja, DEPOIS de
    vários `require`s de framework, e depois até do `import { Kafka } from
    'kafkajs'` que `sandbox/main.ts` já fazia pra criar o tópico), removemos
    `--require`, subimos o docker-compose completo e inspecionamos o Tempo
    span por span. Resultado: `@opentelemetry/instrumentation-http`,
    `-express`, `-router`, `-net` E `-kafkajs` apareceram todos, no MESMO
    trace, incluindo o ciclo completo HTTP → publish Kafka → consume Kafka
    com trace-id preservado — nenhuma lacuna. Explicação técnica: a maioria
    das instrumentações OTel JS faz PATCH DE PROTÓTIPO/objeto compartilhado
    (ex.: `http.Server.prototype.emit`, `Kafka.prototype.producer`) — como
    o protótipo é um objeto ÚNICO compartilhado por todo `require()` do
    mesmo módulo (cache do Node), aplicar o patch depois do `require()`
    ainda funciona, DESDE QUE aconteça antes do MÉTODO ser efetivamente
    INVOCADO (criar servidor, conectar producer) — não antes do import. Como
    nenhuma dessas invocações acontece em module-scope (tudo roda dentro de
    `bootstrap()`, chamado só depois de TODOS os imports síncronos do
    processo terminarem, incluindo o carregamento de `AppModule` e portanto
    de `TelemetryModule.forRoot()`), a janela de tempo é suficiente. O que
    CONTINUA verdade, e é por isso que a implementação ficou dentro do
    corpo estático de `forRoot()` e não num lifecycle hook do Nest
    (`onModuleInit`): `onModuleInit` roda tarde demais, depois de
    `app.listen()`/conexões já estabelecidas — só a avaliação do decorator
    (que acontece no `require()` do módulo, não em runtime assíncrono) é
    cedo o bastante. Efeito colateral que precisou de correção: como
    `forRoot()` pode rodar mais de uma vez no mesmo processo (suíte de
    teste construindo vários `Test.createTestingModule()`),
    `initializeTelemetry()` ganhou uma guarda de idempotência (`if
    (activeSdk) return activeSdk`) — sem isso, cada chamada extra criaria
    um `NodeSDK` novo, reaplicando auto-instrumentação em módulos já
    patcheados (na melhor hipótese redundante, na pior spans duplicados).
    Bug relacionado, achado ao escrever o teste da guarda: `shutdownTelemetry()`
    nunca removia os listeners `SIGTERM`/`SIGINT` que `initializeTelemetry()`
    registra — ciclos repetidos de init/shutdown vazavam 2 listeners por
    ciclo (`MaxListenersExceededWarning` depois de ~5 ciclos). Fix: guardar
    a referência da função handler e chamar `process.removeListener(...)`
    em `shutdownTelemetry()`. `sandbox/tracing.ts` foi removido; `sandbox/package.json`
    volta a ser só `node dist/src/main.js`, sem `--require`.

32. **Licença trocada de MIT pra MIT + Commons Clause** — pedido em duas
    partes, a segunda corrigindo a primeira. Pedido inicial: código aberto,
    mas proibindo uso comercial — implementei com PolyForm Noncommercial
    1.0.0 (descartei licenças Creative Commons pra isso: a própria Creative
    Commons desaconselha usá-las em software, por faltar tratamento de
    patentes e da distinção fonte/binário que uma licença de software
    precisa). Pedido corrigido logo em seguida: a real intenção não era
    proibir uso comercial — empresas PODEM usar a SDK livremente dentro dos
    próprios projetos/produtos, comerciais ou não; a única restrição
    pretendida é impedir alguém de vender A SDK EM SI (repackar/revender o
    código, ou oferecer um serviço hospedado cujo valor vem
    substancialmente da SDK, não do que foi construído com ela). Isso é uma
    restrição bem mais estreita que "não-comercial" — PolyForm Noncommercial
    barraria até uma empresa usando a SDK como dependência interna de um
    produto pago, o que não era a intenção. Troquei pra **MIT + Commons
    Clause**: MIT como base (permissiva, sem restrição de uso comercial) com
    a Commons Clause (rider padrão, curto, bem estabelecido — usada por
    projetos como o antigo RedisGraph) removendo especificamente o direito
    de "Sell" a Software, definido como oferecer a terceiros, mediante
    pagamento, um produto/serviço cujo valor deriva "inteira ou
    substancialmente" da funcionalidade da própria Software — exatamente o
    perímetro que o pedido corrigido descreve. `package.json`'s `license`
    continua `"SEE LICENSE IN LICENSE"` (Commons Clause não é um
    identificador SPDX próprio; é a convenção do npm pra licenças
    combinadas/não-padrão).

33. **`CorrelationIdSource` ganhou um campo opcional `source` (enum
    `CorrelationSource.HTTP`/`CorrelationSource.MESSAGE`).** Pedido do
    usuário, respondendo à dúvida se `correlationIdSources` era
    compartilhado entre HTTP e mensageria: era, e continua sendo — a mesma
    lista é passada a `extractCorrelationId()` tanto por
    `HttpTraceInterceptor` quanto por `MessageTraceInterceptor`, com
    `from: 'header'`/`from: 'body'` resolvidos sobre headers/body do
    transporte que estiver chamando (a função em si não tem nenhuma lógica
    específica de HTTP ou de um broker — funcionaria do mesmo jeito pra um
    futuro interceptor de RabbitMQ, por exemplo). O campo novo não muda esse
    comportamento default (uma entrada sem `source` continua avaliada pra
    ambos, exatamente como antes) — só permite restringir uma entrada
    específica a um único transporte, pra quando a convenção de
    correlation-id diverge entre HTTP e mensageria (ex.: HTTP manda no
    header, mensageria manda só no corpo, e não se quer que uma reconheça
    acidentalmente o formato da outra). `extractCorrelationId()` ganhou um
    quarto parâmetro opcional (`transport?: CorrelationSource`); os dois
    interceptors passam o próprio valor (`CorrelationSource.HTTP`/`.MESSAGE`).
    Assinatura antiga continua funcionando sem o quarto argumento (nenhum
    filtro é aplicado, todas as fontes são tentadas) — mudança aditiva, sem
    breaking change.

34. **`@ContinueTrace()` substituiu `runWithTraceCarrier()` como a forma
    recomendada de consumir um `TraceCarrier`.** Feedback do usuário: ter
    que envolver o corpo inteiro do método processador numa closure
    (`runWithTraceCarrier(carrier, async () => { ... }, options)`) manual,
    empilhando um nível de indentação e uma função anônima, "bagunçava o
    código". `captureTraceCarrier()`/`runWithTraceCarrier()` (decisão 30)
    continuam existindo e exportadas — são a base do decorator novo e
    continuam necessárias fora de um método de classe — mas deixaram de ser
    o caminho ensinado no README. `@ContinueTrace()` (`decorators/continue-trace.decorator.ts`)
    segue o mesmo molde de `@Span()`/`@Measure()`: decora o método, extrai o
    `TraceCarrier` sozinho (padrão: `args[0].trace`, campo configurável via
    `extractCarrier`, pra formatos de payload diferentes) e chama
    `runWithTraceCarrier()` por baixo — o corpo do método processador não
    referencia a SDK de trace-carrier nenhuma vez. Sandbox atualizada
    (`InvoicesService.processDelayedJob`) como demonstração ponta a ponta;
    validado via docker-compose que o resultado (mesmo trace-id, span filho
    de verdade, `app.correlation_id` propagado) é idêntico ao da versão
    anterior com `runWithTraceCarrier()` manual.

35. **`runWithTraceCarrier()` (e seu tipo de opções, `RunWithTraceCarrierOptions`)
    saíram da API pública** — pedido do usuário pra remover a dupla
    `captureTraceCarrier`/`runWithTraceCarrier` agora que `@ContinueTrace()`
    (decisão 34) existe. Avaliei o pedido literal (remover as duas) antes de
    executar: `captureTraceCarrier()` continua sendo o único jeito de gerar
    um `TraceCarrier` no momento em que o job é enfileirado — nada no
    `@ContinueTrace()` (que só decora o lado que RESUME o trace) consegue
    fazer essa captura sozinho, já que ele não tem como saber quando/onde a
    aplicação decide chamar `queue.add()`/publicar um evento/agendar um
    `setTimeout`. Removê-lo quebraria a funcionalidade inteira sem
    substituto. Perguntei ao usuário como prosseguir; a resposta confirmou
    manter `captureTraceCarrier()` público e remover só `runWithTraceCarrier()`,
    que agora é puramente um detalhe de implementação de `@ContinueTrace()`
    — nenhum caso de uso documentado precisa chamá-lo diretamente. Mudança:
    removido de `src/index.ts`; a função e seu tipo de opções continuam
    `export`ados dentro de `context/trace-carrier.ts` (import interno
    normal, usado por `continue-trace.decorator.ts`), só não fazem mais
    parte do barrel público — não estão em `dist/index.d.ts`. Efeito
    colateral técnico: `ContinueTraceOptions` (exportado publicamente)
    estendia `RunWithTraceCarrierOptions`; como esse segundo tipo deixou de
    ser público, `ContinueTraceOptions` teve os dois campos (`spanName`,
    `attributes`) copiados diretamente pra sua própria declaração em vez de
    herdar por `extends` — sem isso, a emissão de `.d.ts` falha (“has or is
    using private name”) por referenciar um tipo não exportado numa
    interface pública.

36. **Correções de achados do GitHub code scanning / socket.dev.** Cinco
    itens reportados; dois eram vulnerabilidades reais e corrigidas, três
    eram capacidades inerentes ao design ou dependências fora do nosso
    controle, documentadas em vez de "corrigidas":

    - **ReDoS polinomial real em `appendOtlpPathIfMissing()`
      (`telemetry-config.ts`)**: `url.replace(/\/+$/, '')` trimava barras
      finais de `endpoint` (config vinda do usuário) com um regex.
      Confirmado empiricamente, não só pelo alerta: `'/'.repeat(200_000)`
      seguido de qualquer caractere não-barra levou o regex a ~24.7
      SEGUNDOS (uma corrida de barras que não termina exatamente no fim da
      string força o motor a fazer backtrack em CADA posição dentro dela).
      Fix: `stripTrailingSlashes()`, um loop manual O(n) sem regex nenhum —
      mesmo comportamento, sem essa classe de vulnerabilidade. Teste de
      segurança adicionado (`security.spec.ts`) provando tempo limitado
      pra esse input adversarial específico.

    - **`process.env.LOG_LEVEL` lido implicitamente em `trace-logger.ts`**:
      Socket.dev sinaliza qualquer acesso a `process.env` como possível
      indício de roubo de credencial — falso positivo aqui (só controlava
      o nível de log do console), mas o acesso implícito a env var
      também contradizia a própria filosofia da SDK pós-decisão 2 (uma
      única fonte de configuração explícita, nada implícito via env var).
      Fix que resolve as duas coisas de uma vez: `TraceLogger` ganhou um
      segundo parâmetro posicional opcional, `consoleLevel` (default
      `'info'`), mudança aditiva — `new TraceLogger()`/`new
      TraceLogger('Ctx')` continuam funcionando sem alteração. `LOG_LEVEL`
      não é mais lido em lugar nenhum do código.

    - **`safe-buffer`/`readable-stream` (via cadeia transitiva de
      `pino`/`pino-pretty`) sinalizados pelo "Socket Optimized Override"**:
      não é uma vulnerabilidade (`safe-buffer` não tem CVE conhecido) — é
      uma sugestão do PRODUTO do Socket.dev pra substituir por forks deles
      próprios via `overrides`, o que trocaria confiança no mantenedor
      original por confiança no registry deles; descartado por
      desproporcional a um risco praticamente nulo. Em vez disso, resolvi
      de verdade: `pino@8`→`^10.3.1` e `pino-pretty@10`→`^13.1.3`
      eliminam `readable-stream` (e portanto `safe-buffer`) da árvore de
      dependências inteira — confirmado via `npm ls safe-buffer` vazio
      depois do bump. Validado com um smoke test real (não mockado) do
      `pino({ transport: { target: 'pino-pretty' } })` — a suíte mocka
      `pino` inteiro, então não pegaria uma quebra de runtime nessa major
      bump sozinha.

    - **`node:async_hooks` sinalizado como "debug, reflection e dynamic
      code execution features" em `trace-context.js`**: capacidade
      inerente ao design, não uma vulnerabilidade — `AsyncLocalStorage`
      (`node:async_hooks`) é o mecanismo central de propagação de
      trace/correlation-id por todo o request (`TraceContextManager`, ver
      decisão original de arquitetura). Socket.dev classifica
      `async_hooks` sob um rótulo genérico de "recursos avançados" junto
      com `vm`/`Function` constructor — não há como remover sem quebrar a
      SDK inteira. Nada foi alterado; é esperado que essa flag apareça em
      qualquer allowlist/aceite de risco de quem rodar Socket.dev sobre
      este pacote.

    - **"Obfuscated code" em `@protobufjs/float`, `rimraf`, `strtok3`,
      `yargs`**: nenhum dos quatro é dependência direta nossa —
      `@protobufjs/float`/`yargs` vêm de `@opentelemetry/sdk-node` →
      `@grpc/grpc-js` (código do exporter gRPC, que a SDK nem usa em
      runtime — só os exporters HTTP/protobuf, ver decisão 1 — mas
      `@opentelemetry/sdk-node` traz a dependência de qualquer jeito);
      `rimraf` vem de `@opentelemetry/auto-instrumentations-node` →
      detector de recurso GCP; `strtok3` vem de `@nestjs/common` →
      `file-type` — ou seja, QUALQUER app NestJS 11 carrega essa cadeia,
      independente desta SDK. Nenhum dos quatro tem CVE conhecido; são
      pacotes estáveis, amplamente auditados, e "obfuscated" aqui quase
      certamente é heurística batendo em código denso/bitwise legítimo
      (`@protobufjs/float` faz codificação IEEE-754 manual, por exemplo).
      Não há fix possível do nosso lado — dependência transitiva de
      dependências que já estão na versão mais recente compatível.

37. **`TelemetryModule` não tem `forRootAsync()` — tentado, implementado,
    testado empiricamente, e revertido depois de achar um bug sério, não
    hipotético.** Pergunta original do usuário: por que não suportar
    `useFactory`/`inject` como `ConfigModule`/`TypeOrmModule` fazem, pra
    valores que só um serviço de configuração assíncrono consegue prover?

    **Primeira análise (incompleta, corrigida abaixo):** um `forRootAsync()`
    resolveria através do container de DI, que só existe DENTRO de
    `NestFactory.create()`. Achei, por dedução, que o risco seria estreito:
    "só" providers que fazem I/O instrumentável no próprio bootstrap
    (construtor, `onModuleInit`) e que o Nest resolva antes do nosso
    factory (Nest não garante ordem entre módulos) ficariam sem trace —
    tráfego real de request, raciocinei, estaria seguro, porque por
    definição só começa a fluir depois que TODO o DI (incluindo nosso
    factory) já terminou. Testei separadamente (via `import()` dinâmico em
    `main.ts`, adiando TODOS os imports — não só os do Nest — pra depois de
    um `await` simulando um secrets manager) que dá pra ter config
    assíncrona SEM DI nenhum, preservando cobertura total de
    auto-instrumentação (HTTP, Express, Kafka) — isso está correto e seguia
    documentado no README ("Sourcing configuration asynchronously").

    **O usuário pediu pra implementar `forRootAsync()` mesmo assim.**
    Implementei (`useFactory`/`inject`/`imports`, convenção padrão do
    ecossistema Nest, com `TELEMETRY_CONFIG` como provider `useFactory`
    assíncrono chamando `initializeTelemetry()` só depois de resolver o
    config) e testei end-to-end no sandbox, exatamente como decisão 31 e o
    parágrafo acima — mesmo padrão de rigor. **O resultado contradisse a
    primeira análise por completo**: `POST /invoices` e `GET /health`
    pararam de gerar QUALQUER span de `@opentelemetry/instrumentation-http`/
    `-express`/`-router` — não em casos raros de corrida entre providers,
    em TODA requisição HTTP, sempre, de forma 100% reprodutível. Kafka e
    spans manuais (`@Span`) continuaram funcionando normalmente.

    Isolei a causa fora do Nest/sandbox pra confirmar o mecanismo exato:

    ```js
    // FALHA: require('http') acontece ANTES de sdk.start(), mesmo só ~300ms antes
    const http = require('http');
    await sleep(300);
    /* getNodeAutoInstrumentations() + sdk.start() */
    const server = http.createServer(...); // nenhum span gerado, nunca

    // FUNCIONA: primeiro require('http') só depois de sdk.start()
    await sleep(300);
    /* getNodeAutoInstrumentations() + sdk.start() */
    const http = require('http'); // spans gerados normalmente
    ```

    Confirmado lendo o source de `@opentelemetry/instrumentation-http`:
    o patch é sim em `Server.prototype.emit` (protótipo compartilhado,
    não uma instância) — a decisão 31 estava certa sobre ISSO. O que a
    decisão 31 não tinha testado (porque nesse teste `http` nunca tinha
    sido `require`'d por ninguém antes) é que o MECANISMO de hook pra
    módulos NATIVOS do Node (`http`, `https`, ...) aparentemente não
    re-intercepta um módulo cujo require já aconteceu antes do SDK
    registrar as instrumentações — diferente de módulos userland como
    `kafkajs`, que continuaram funcionando mesmo `require`'dos antes.
    `NestFactory.create()` cria o adapter Express (e portanto `require('http')`)
    bem no início da própria execução — ou seja, ANTES do container de DI
    resolver nosso factory assíncrono, em qualquer app real. Não é uma
    condição de corrida rara: é garantido acontecer sempre que
    `forRootAsync()` é usado.

    Revertido por completo (`forRootAsync`/`TelemetryModuleAsyncOptions`
    removidos de `telemetry.module.ts`/`index.ts`, testes removidos,
    `sandbox/` restaurada). `TelemetryModule.forRoot()` continua sendo a
    única API. Pra configuração de fontes assíncronas, a resposta certa
    continua sendo o padrão de `import()` dinâmico (parágrafo anterior,
    README) — que nunca sofre desse problema porque `http` também não é
    `require`'do até depois do `await`, exatamente como o `forRoot()`
    síncrono original. Lição maior, reforçando a decisão 31: "prototype
    patching sobrevive a require tardio" não é uma regra universal do OTel
    JS — vale para a maioria dos módulos userland testados até agora, mas
    não necessariamente para módulos nativos do Node. Não generalizar sem
    testar de novo, pra cada mecanismo de instrumentação novo.

38. **`@ContinueTrace()` parou de criar span próprio — passou a fazer só
    retomada de contexto, exatamente como `runWithRemoteParent()`/
    `TraceContextManager` fazem pros outros sinais.** Crítica do usuário,
    correta: por que `ContinueTraceOptions` tinha `spanName`/`attributes`
    se `@Span()` já existe pra isso? Ele já combinava os dois no mesmo
    método (`@Span` + `@ContinueTrace`) e isso gerava DOIS spans
    desconectados — o de `@Span()` (filho de qualquer contexto que
    estivesse ativo ANTES do método rodar, tipicamente nenhum) e o de
    `@ContinueTrace()` (filho do trace remoto capturado, criado
    INTERNAMENTE por `runWithTraceCarrier()` depois de `@ContinueTrace()`
    já ter re-parentado o contexto ativo) — duas árvores de trace
    separadas pra uma única chamada de método, exatamente a "interferência"
    que o usuário suspeitava.

    Fix: `runWithTraceCarrier()` (que criava span, decisão 30) virou
    `resumeTraceCarrier()` — só re-parenta o contexto OTel ativo
    (`runWithRemoteParent`) e o `TraceContextManager` (trace id/correlation
    id), sem chamar `tracer.startActiveSpan()` nenhuma vez. `@ContinueTrace()`
    ficou só com `extractCarrier` em `ContinueTraceOptions` — `spanName`/
    `attributes` saíram, porque a responsabilidade de nomear/anotar um span
    é do `@Span()`. Documentado que a ordem de composição importa:
    `@ContinueTrace()` PRECISA vir ACIMA de `@Span()` (executa primeiro,
    decorators aplicam de baixo pra cima — o de baixo vira o wrapper mais
    interno), pra que o span do `@Span()` já nasça filho do trace
    retomado, não da raiz.

    Efeito colateral que precisou de correção pra não regredir a decisão
    29: o atributo `app.correlation_id` só era marcado por
    `TraceContextManager.createContext()` no span ATIVO no momento da
    chamada — que, sem `@ContinueTrace()` criar mais um span, é um
    `NonRecordingSpan` (placeholder do `runWithRemoteParent`), onde
    `setAttribute()` é no-op. Sem ajuste, o correlation-id nunca chegaria
    no span de verdade criado depois pelo `@Span()`. Fix (também corrige
    uma lacuna pré-existente, não só do `@ContinueTrace()`): `@Span()`
    agora também marca `app.correlation_id` no PRÓPRIO span que cria,
    lendo `TraceContextManager.getCorrelationId()` — antes disso, um
    `@Span()` aninhado dentro de uma requisição HTTP (ex.: `invoice.fraud-check`
    dentro de `invoice.process-payment`) nunca recebia esse atributo, só o
    span raiz da requisição (marcado uma vez pelo interceptor). Agora
    qualquer span criado por `@Span()` carrega o correlation-id ativo,
    dentro ou fora de `@ContinueTrace()`.

39. **`@ContinueTrace()` + `@Span()` funcionam em QUALQUER ordem — não é
    mais preciso decorar `@ContinueTrace()` acima de `@Span()`.** Pedido do
    usuário, direto: "todos os nossos decorators não deve ter restrição de
    ordem" — mesmo princípio já estabelecido antes pra `@Span`/`@Get()`
    (decisão sobre `copyMethodMetadata`/`preserveFunctionName`), agora
    estendido pra composição ENTRE decorators desta SDK, não só com os do
    Nest. A decisão 38 introduziu a exigência de ordem (`@ContinueTrace()`
    precisa vir acima, senão `@Span()` cria o span ANTES do trace ser
    retomado, virando raiz de uma árvore desconexa) — o usuário rejeitou
    isso como a mesma classe de amadorismo já corrigida antes.

    Fix: mecanismo de coordenação via `reflect-metadata`, simétrico ao que
    já existe pra sobreviver a wrapping (`copyMethodMetadata`), mas usado
    aqui pra COMUNICAÇÃO entre decorators, não só preservação. `@ContinueTrace()`
    marca a função que produz com uma chave de metadata própria (símbolo
    não exportado) guardando seu `extractCarrier` resolvido. `@Span()`, ao
    aplicar, verifica essa metadata na função que está envolvendo — se
    presente (`@ContinueTrace()` em QUALQUER posição da pilha, direta ou
    atrás de outro decorator como `@Measure()`, já que `copyMethodMetadata`
    propaga toda chave de metadata genericamente, não só as do Nest), `@Span()`
    envolve sua PRÓPRIA lógica de criação de span dentro de um
    `resumeTraceCarrier()`, extraindo o carrier via a função guardada,
    ANTES de chamar `tracer.startActiveSpan()`. Efeito: não importa se
    `@ContinueTrace()` é o wrapper mais externo (já funcionava antes, sem
    mudança) ou o mais interno (agora corrigido) — o span do `@Span()`
    sempre nasce filho do trace retomado.

    Efeito colateral aceito conscientemente quando `@Span()` é o wrapper
    externo: a retomada de contexto acontece DUAS vezes (uma pelo `@Span()`,
    envolvendo a criação do span; outra pelo `@ContinueTrace()` original,
    ao ser chamado por dentro) — redundante mas inofensivo
    (`resumeTraceCarrier()` é idempotente: re-parentar pro mesmo contexto
    remoto, ou marcar o mesmo correlation-id de novo no mesmo span, não tem
    efeito colateral observável). Preferido a "desembrulhar" o método
    original pra evitar a duplicata, que exigiria expor o método cru via
    metadata também — complexidade desproporcional ao ganho.

    Validado empiricamente na sandbox (não só nos testes unitários — mesmo
    padrão de rigor das decisões 31/37): inverti a ordem de
    `InvoicesService.processDelayedJob` pra `@Span()` acima de
    `@ContinueTrace()` (a ordem antes quebrada) e confirmei via Tempo real
    que `invoice.delayed-processing` continua filho do mesmo trace que
    `invoice.process-payment` (mesmo `parentSpanId` do span raiz da
    requisição HTTP), com `app.correlation_id` presente — revertido depois
    do teste, sandbox usa a ordem `@ContinueTrace()`/`@Span()` só por
    convenção de leitura agora, não porque uma ordem diferente quebraria
    algo.

40. **`ContinueTraceOptions.extractCarrier` tinha que ser `(...args: any[])`,
    não `(...args: unknown[])` — bug real de tipagem, reportado pelo
    usuário usando a própria documentação da decisão 39/README ao pé da
    letra.** `unknown[]` parecia a escolha "mais segura" (evita `any`
    implícito) mas quebra o caso de uso inteiro: sob checagem contravariante
    de parâmetros do TypeScript, `(job: Job<X>) => T` NÃO é atribuível a
    `(...args: unknown[]) => T`, porque `unknown` não é atribuível a `Job<X>`
    (o inverso de "qualquer coisa é atribuível a `unknown`") — exatamente o
    erro "Types of parameters ... are incompatible" que o usuário viu. Ou
    seja: TODO exemplo documentado com um `extractCarrier` tipado
    (`(job: Job<...>) => job.data.trace`, decisão 39, README) simplesmente
    não compilava — o bug estava nos PRÓPRIOS exemplos que eu escrevi.
    Fix: trocar pra `(...args: any[]) => TraceCarrier | undefined`, mesma
    convenção que o Nest usa em `FactoryProvider.useFactory`/`inject` pelo
    mesmo motivo exato — o parâmetro é inerentemente "o que quer que o
    consumidor declare", não dá pra tipar com segurança de antemão, e
    `any[]` (ao contrário de `unknown[]`) é bidirecionalmente compatível
    com qualquer assinatura de função concreta. Verificado contra o
    `dist/index.d.ts` publicado de verdade (não só `src/`, já que
    `tsconfig.json` raiz só cobre `src/` — `test/` não é type-checked por
    `npm run build`/`tsc --noEmit`, só transpilado pelo esbuild do Vitest,
    que não pega erro de tipo): um `.ts` isolado importando o pacote
    buildado, com um `extractCarrier` tipado exatamente como o exemplo do
    README, compilou limpo depois do fix. Testes do repositório também
    limpos de casts `(job: unknown) => (job as {...})` que mascaravam esse
    problema — agora usam interfaces tipadas de verdade, mesmo padrão dos
    exemplos públicos.

## O que ainda NÃO foi construído

- `MessageTraceInterceptor` pra RabbitMQ (Kafka já está pronto — ver
  decisão 11; RabbitMQ precisaria de extração de headers própria, formato
  `amqplib` é diferente do `KafkaContext`)
- Dashboards prontos do Grafana (só datasources provisionadas, sem
  dashboard custom)
- `package.json` não tem `repository`/`homepage`/`bugs` — preencher quando
  o repo tiver um remote real
- Datasource do Loki não mapeia `app.correlation_id` como campo pra pular
  direto pro Tempo (só `trace_id`, via `derivedFields`) — daria pra
  adicionar, mas exigiria promover correlation_id a structured metadata
  filtrável no Loki primeiro; TraceQL (`{ span.app.correlation_id = "..." }`,
  decisão 29) já cobre a busca por correlation_id sem essa peça

## Comandos úteis

```bash
# Build da SDK
npm install && npm run build

# Testes (Vitest)
npm test               # roda uma vez
npm run test:watch     # watch mode
npm run test:coverage  # com relatório de cobertura

# Rodar a sandbox sem Docker (precisa de um Kafka acessível em
# localhost:9092 — ex: `docker compose -f sandbox/docker/docker-compose.yml up -d kafka`
# com KAFKA_ADVERTISED_LISTENERS trocado pra localhost:9092 nesse caso)
cd sandbox && npm install && npm run build
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 KAFKA_BROKERS=localhost:9092 npm start

# Stack completo (Collector + Tempo + Loki + Prometheus + Grafana + Kafka + app)
docker compose -f sandbox/docker/docker-compose.yml up --build
```
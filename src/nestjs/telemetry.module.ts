import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { resolveTelemetryConfig, type TelemetryConfig } from '../config/telemetry-config';
import { initializeTelemetry } from '../bootstrap/initialize-telemetry';
import { HttpTraceInterceptor } from '../interceptors/http-trace.interceptor';
import { TELEMETRY_CONFIG } from './telemetry.tokens';

/**
 * The SDK's single entry point: initializes the OpenTelemetry SDK
 * (auto-instrumentations, exporters — same work `initializeTelemetry()`
 * does on its own) AND registers {@link HttpTraceInterceptor} globally AND
 * exposes the resolved configuration (`TELEMETRY_CONFIG`) to the rest of
 * the application — including `MessageTraceInterceptor`, which this module
 * does not register itself (apply it via `@UseInterceptors(...)` where
 * needed) but which reads the same configuration by injection, since this
 * module is global.
 *
 * One config object, one call, one place — see claude.md for why this is
 * safe despite auto-instrumentation's usual "must run before any other
 * import" requirement: `forRoot()` runs as part of evaluating
 * `AppModule`'s own `@Module()` decorator, which happens the moment
 * `AppModule` is `require()`d — before `NestFactory.create()`, before any
 * HTTP server is created, before any Kafka client connects. That is early
 * enough for every OTel JS instrumentation this SDK ships with.
 *
 * There is deliberately no `forRootAsync()` — see claude.md, decision 37,
 * for why a DI-resolved (`useFactory`/`inject`) config source is
 * fundamentally incompatible with the guarantee above, confirmed by direct
 * reproduction (Node core module instrumentation, `http` included, does
 * not retroactively patch a module already `require()`d before
 * `NodeSDK.start()` runs — unlike most userland instrumentations).
 *
 * @example
 * ```ts
 * // telemetry.config.ts
 * export const telemetryConfig: TelemetryConfig = {
 *   serviceName: 'billing-service',
 *   environment: process.env.NODE_ENV,
 *   ignoreRoutes: ['/health'],
 * };
 *
 * // app.module.ts
 * @Module({ imports: [TelemetryModule.forRoot(telemetryConfig)] })
 * export class AppModule {}
 * ```
 */
@Global()
@Module({})
export class TelemetryModule {
  /** @param config see {@link TelemetryConfig}. */
  static forRoot(config: TelemetryConfig): DynamicModule {
    initializeTelemetry(config);

    return {
      module: TelemetryModule,
      providers: [
        { provide: TELEMETRY_CONFIG, useValue: resolveTelemetryConfig(config) },
        { provide: APP_INTERCEPTOR, useClass: HttpTraceInterceptor },
      ],
      exports: [TELEMETRY_CONFIG],
    };
  }
}

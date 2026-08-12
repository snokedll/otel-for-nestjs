import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { TelemetryModule } from '@snokedll/otel-for-nestjs';
import { AppController } from './app.controller';
import { HttpLoggingInterceptor } from './common/http-logging.interceptor';
import { InvoicesModule } from './invoices/invoices.module';
import { telemetryConfig } from './telemetry.config';

@Module({
  imports: [
    // Único lugar que configura a SDK inteira — inicializa o OpenTelemetry
    // SDK e registra os interceptors, veja ./telemetry.config.ts.
    TelemetryModule.forRoot(telemetryConfig),
    ScheduleModule.forRoot(),
    InvoicesModule,
  ],
  controllers: [AppController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor }],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { AvailabilityModule } from './availability/availability.module';
import { CustomersModule } from './customers/customers.module';

@Module({
  imports: [AvailabilityModule, CustomersModule],
})
export class AppModule {}

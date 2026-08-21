import { Controller } from '@nestjs/common';
import { CustomersService } from '../customers/customers.service';

@Controller('availability')
export class AvailabilityController {
  constructor(private readonly customers: CustomersService) {}
}

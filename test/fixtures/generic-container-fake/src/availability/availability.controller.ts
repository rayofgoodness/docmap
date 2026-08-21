import { CustomersService } from '../customers/customers.service';

export class AvailabilityController {
  constructor(private readonly customers: CustomersService) {}
}

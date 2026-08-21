import { Injectable } from '@nestjs/common';

@Injectable()
export class AvailabilityService {
  check(): boolean {
    return true;
  }
}

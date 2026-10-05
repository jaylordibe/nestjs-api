import { Global, Module } from '@nestjs/common';
import { DestinationSendLimitService } from './destination-send-limit.service';

@Global()
@Module({
  providers: [DestinationSendLimitService],
  exports: [DestinationSendLimitService],
})
export class SendLimitModule {}

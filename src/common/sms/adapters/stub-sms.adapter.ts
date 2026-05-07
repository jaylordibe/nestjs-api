import { Injectable, Logger } from '@nestjs/common';
import { OutgoingSms, SmsAdapter } from './sms-adapter.interface';

// Used when SMS_PROVIDER=stub (default for development and test env).
// Logs the message instead of hitting a real carrier so local flows can
// observe what would have been sent. Preserves developer UX — OTPs
// visible in the console, no surprise API calls or carrier charges.
@Injectable()
export class StubSmsAdapter implements SmsAdapter {
  private readonly logger = new Logger(StubSmsAdapter.name);

  send(message: OutgoingSms): Promise<void> {
    this.logger.log(
      `[sms:stub] to=${message.to} body=${JSON.stringify(message.body)}`,
    );
    return Promise.resolve();
  }
}

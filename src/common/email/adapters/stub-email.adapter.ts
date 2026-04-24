import { Injectable, Logger } from '@nestjs/common';
import { EmailAdapter, OutgoingEmail } from './email-adapter.interface';

// Used when EMAIL_PROVIDER=stub (default for development and test env).
// Logs the rendered message instead of hitting a real provider so local
// flows can observe what would have been sent. Preserves developer UX —
// OTPs visible in the console, no surprise API calls in tests.
@Injectable()
export class StubEmailAdapter implements EmailAdapter {
  private readonly logger = new Logger(StubEmailAdapter.name);

  send(message: OutgoingEmail): Promise<void> {
    this.logger.log(
      `[email:stub] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`,
    );
    return Promise.resolve();
  }
}

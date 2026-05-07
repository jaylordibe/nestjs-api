export interface OutgoingSms {
  to: string;
  body: string;
}

// Concrete adapters live alongside this interface and are swapped at the
// module level via the SMS_ADAPTER DI token. Adapters receive a fully-
// formed message body — any templating (OTP code, expiry minutes, etc.)
// happens upstream in SmsService so adapters never deal with variables.
export interface SmsAdapter {
  send(message: OutgoingSms): Promise<void>;
}

export const SMS_ADAPTER = Symbol('SMS_ADAPTER');

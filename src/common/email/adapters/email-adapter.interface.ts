export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

// Concrete adapters live alongside this interface and are swapped at the
// module level via the EMAIL_ADAPTER DI token. Every adapter receives a
// fully-rendered message — templates are resolved upstream in
// EmailService, so adapters never deal with variables or HTML escaping.
export interface EmailAdapter {
  send(message: OutgoingEmail): Promise<void>;
}

export const EMAIL_ADAPTER = Symbol('EMAIL_ADAPTER');

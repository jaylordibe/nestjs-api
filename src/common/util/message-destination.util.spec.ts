import { canonicalEmailDestination } from './message-destination.util';

describe('canonicalEmailDestination', () => {
  it.each([
    ['Victim@Example.com', 'victim@example.com'],
    ['  victim@example.com  ', 'victim@example.com'],
    ['victim+news@example.com', 'victim@example.com'],
    ['v.i.c.t.i.m@gmail.com', 'victim@gmail.com'],
    ['V.ictim+1@GoogleMail.com', 'victim@gmail.com'],
    ['"victim"@example.com', 'victim@example.com'],
    ['victim@müller.de', 'victim@xn--mller-kva.de'],
    ['victim@xn--mller-kva.de', 'victim@xn--mller-kva.de'],
  ])('maps %s to %s', (input, expected) => {
    expect(canonicalEmailDestination(input)).toBe(expected);
  });

  // Dots only collapse where the provider ignores them; elsewhere they name
  // a different mailbox and must keep their own budget.
  it('keeps dots outside Gmail', () => {
    expect(canonicalEmailDestination('first.last@example.com')).toBe(
      'first.last@example.com',
    );
    expect(canonicalEmailDestination('firstlast@example.com')).not.toBe(
      canonicalEmailDestination('first.last@example.com'),
    );
  });

  it('keeps distinct mailboxes distinct', () => {
    expect(canonicalEmailDestination('alice@example.com')).not.toBe(
      canonicalEmailDestination('bob@example.com'),
    );
  });

  it('keeps a leading plus as part of the local part', () => {
    expect(canonicalEmailDestination('+tag@example.com')).toBe(
      '+tag@example.com',
    );
  });
});

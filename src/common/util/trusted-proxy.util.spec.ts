import { isTrustedProxyList } from './trusted-proxy.util';

describe('isTrustedProxyList', () => {
  it.each([
    '172.30.0.10',
    '172.30.0.10,172.30.0.20',
    '172.30.0.10, 10.0.0.0/24',
    '127.0.0.1',
    '::1',
    '2001:db8::/32',
    '10.0.0.0/8',
    '0.0.0.0/32',
    '10.0.0.0/1',
    '::ffff:10.0.0.0/104',
  ])('accepts %s', (value) => {
    expect(isTrustedProxyList(value)).toBe(true);
  });

  // Every form Express accepts that trusts a peer nobody named, plus the
  // malformed entries Express would throw on at boot.
  it.each([
    ['a hop count', '2'],
    ['trust everything', 'true'],
    ['a keyword', 'uniquelocal'],
    ['a keyword in a list', '172.30.0.10,loopback'],
    ['a hostname', 'caddy'],
    ['every IPv4 address', '0.0.0.0/0'],
    ['every IPv6 address', '::/0'],
    ['the whole IPv4-mapped block', '::ffff:0.0.0.0/96'],
    ['a mapped address with a short prefix', '::ffff:10.0.0.1/24'],
    ['an IPv6 range spanning the mapped block', '::/8'],
    ['an empty entry', '172.30.0.10,'],
    ['an empty value', ''],
    ['an IPv4 prefix past 32', '10.0.0.0/33'],
    ['an IPv6 prefix past 128', '2001:db8::/129'],
    ['a netmask instead of a prefix', '10.0.0.0/255.0.0.0'],
    ['a double slash', '10.0.0.0/8/8'],
    ['a port', '172.30.0.10:443'],
  ])('rejects %s', (_case, value) => {
    expect(isTrustedProxyList(value)).toBe(false);
  });
});

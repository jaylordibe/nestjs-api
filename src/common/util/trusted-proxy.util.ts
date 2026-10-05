import { BlockList, isIP } from 'node:net';

/**
 * Whether `TRUST_PROXY` is a comma-separated list of IP addresses and CIDR
 * ranges — the trusted hops whose `X-Forwarded-For` Express believes.
 *
 * Only literals, on purpose. Express's other forms each trust something nobody
 * named: a hop count trusts whatever connects directly, `true` trusts every
 * peer, and `loopback` / `uniquelocal` trust every container on a private
 * network. Any of those lets a peer choose its own `request.ip` — the key for
 * rate limits, refresh-token provenance and the audit trail. A `/0` range is
 * `true` spelled as a CIDR, and so is an IPv6 range spanning the whole
 * IPv4-mapped block (`::ffff:0.0.0.0/96`, `::/8`): Express matches every IPv4
 * peer against it. A hostname cannot be resolved; Express throws at boot on it
 * and on `/0`, after this schema has already passed.
 */
export function isTrustedProxyList(value: string): boolean {
  const entries = value.split(',').map((entry) => entry.trim());
  return entries.length > 0 && entries.every(isAddressOrRange);
}

function isAddressOrRange(entry: string): boolean {
  const [address = '', prefixLength, ...extra] = entry.split('/');
  if (extra.length > 0) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefixLength === undefined) return true;
  if (!/^\d{1,3}$/.test(prefixLength)) return false;
  const bits = Number(prefixLength);
  if (bits < 1 || bits > (family === 4 ? 32 : 128)) return false;
  return family === 4 || !coversEveryIpv4Address(address, bits);
}

function coversEveryIpv4Address(address: string, bits: number): boolean {
  const range = new BlockList();
  range.addSubnet(address, bits, 'ipv6');
  return (
    range.check('::ffff:0.0.0.0', 'ipv6') &&
    range.check('::ffff:255.255.255.255', 'ipv6')
  );
}

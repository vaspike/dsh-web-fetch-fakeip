/**
 * Address classification for the fake-ip tolerant fetch provider.
 *
 * The upstream `@deepseek-ai/dsh-web-fetch-http` provider rejects a hostname when
 * *any* resolved address is not public unicast, which makes it unusable behind a
 * DNS fake-ip implementation (Clash, sing-box, Surge and friends all answer with
 * addresses in a reserved range such as 198.18.0.0/15).
 *
 * This module is the replacement decision: an address is allowed when it falls
 * inside a caller-supplied CIDR allow list, and otherwise it must be public
 * unicast. It is dependency-free and pure so it can be unit tested without the
 * harness runtime.
 *
 * @module dsh-web-fetch-fakeip/lib/classify
 */

/** Reserved IPv4 blocks that must never be treated as a public destination. */
const BLOCKED_V4 = [
  '0.0.0.0/8', // "this network" (RFC 791)
  '10.0.0.0/8', // private (RFC 1918)
  '100.64.0.0/10', // carrier-grade NAT (RFC 6598)
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link local
  '172.16.0.0/12', // private (RFC 1918)
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1
  '192.88.99.0/24', // 6to4 relay anycast
  '192.168.0.0/16', // private (RFC 1918)
  '198.18.0.0/15', // benchmarking / fake-ip default
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved + broadcast
]

/** Reserved IPv6 blocks that must never be treated as a public destination. */
const BLOCKED_V6 = [
  '::/128', // unspecified
  '::1/128', // loopback
  'fc00::/7', // unique local (RFC 4193)
  'fe80::/10', // link local
  'ff00::/8', // multicast
  '2001:db8::/32', // documentation
]

/** Bit width of each family's address space. */
const WIDTH = { 4: 32n, 6: 128n }

/**
 * Parse a dotted-quad IPv4 literal into a 32-bit value.
 *
 * @param text - candidate address.
 * @returns the numeric value, or `undefined` when `text` is not an IPv4 literal.
 */
export function parseIPv4(text) {
  const parts = text.split('.')
  if (parts.length !== 4) return undefined
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

/**
 * Parse an IPv6 literal (including `::` compression and a trailing dotted quad)
 * into a 128-bit value.
 *
 * @param text - candidate address, without brackets.
 * @returns the numeric value, or `undefined` when `text` is not an IPv6 literal.
 */
export function parseIPv6(text) {
  if (!text.includes(':')) return undefined
  const halves = text.split('::')
  if (halves.length > 2) return undefined

  const head = splitGroups(halves[0])
  const tail = halves.length === 2 ? splitGroups(halves[1]) : []
  if (head === undefined || tail === undefined) return undefined

  const missing = 8 - head.length - tail.length
  // `::` may stand for one or more zero groups; a full spelling has no `::`.
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined

  const groups = [...head, ...new Array(halves.length === 2 ? missing : 0).fill(0), ...tail]
  if (groups.length !== 8) return undefined

  let value = 0n
  for (const group of groups) value = (value << 16n) | BigInt(group)
  return value
}

/**
 * Split a `:`-separated chunk of an IPv6 literal into 16-bit groups, expanding a
 * trailing dotted quad into the two groups it occupies.
 *
 * @param chunk - one side of a `::` split, possibly empty.
 * @returns the groups, or `undefined` when the chunk is malformed.
 */
function splitGroups(chunk) {
  if (chunk === '') return []
  const groups = []
  const segments = chunk.split(':')
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment.includes('.')) {
      if (index !== segments.length - 1) return undefined
      const embedded = parseIPv4(segment)
      if (embedded === undefined) return undefined
      groups.push(Number((embedded >> 16n) & 0xffffn), Number(embedded & 0xffffn))
      continue
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(segment)) return undefined
    groups.push(Number.parseInt(segment, 16))
  }
  return groups
}

/**
 * Parse either address family into a comparable pair.
 *
 * @param text - candidate address, without brackets.
 * @returns the family and numeric value, or `undefined` when unparseable.
 */
export function parseAddress(text) {
  const v4 = parseIPv4(text)
  if (v4 !== undefined) return { family: 4, value: v4 }
  const v6 = parseIPv6(text)
  if (v6 !== undefined) return { family: 6, value: v6 }
  return undefined
}

/**
 * Parse a CIDR block such as `198.18.0.0/15`.
 *
 * @param text - the CIDR string.
 * @param label - config key name used in thrown messages.
 * @returns the parsed range.
 * @throws {Error} when the block is malformed or its prefix length is out of range.
 */
export function parseCidr(text, label = 'allowCidrs') {
  if (typeof text !== 'string') throw new Error(`${label}: expected a string, received ${typeof text}`)
  const pieces = text.trim().split('/')
  if (pieces.length > 2) throw new Error(`${label}: "${text}" is not a CIDR block`)
  const [address, prefixText] = pieces
  const parsed = parseAddress(address)
  if (parsed === undefined) throw new Error(`${label}: "${text}" does not start with an IP address`)
  const width = WIDTH[parsed.family]
  const bits = prefixText === undefined ? Number(width) : Number(prefixText)
  if (!Number.isInteger(bits) || bits < 0 || BigInt(bits) > width) {
    throw new Error(`${label}: "${text}" has an invalid prefix length`)
  }
  const shift = width - BigInt(bits)
  return { family: parsed.family, bits, base: (parsed.value >> shift) << shift }
}

/**
 * Whether an address falls inside a parsed CIDR block.
 *
 * @param address - the address to test.
 * @param range - a value from {@link parseCidr}.
 * @returns true when the address is inside the block.
 */
export function addressInRange(address, range) {
  const parsed = parseAddress(address)
  if (parsed === undefined || parsed.family !== range.family) return false
  const shift = WIDTH[parsed.family] - BigInt(range.bits)
  return (parsed.value >> shift) << shift === range.base
}

const BLOCKED_V4_RANGES = BLOCKED_V4.map((block) => parseCidr(block, 'blocked'))
const BLOCKED_V6_RANGES = BLOCKED_V6.map((block) => parseCidr(block, 'blocked'))

/**
 * Whether an address is a public unicast destination.
 *
 * Anything reserved, private, loopback, link-local, multicast, or otherwise
 * unroutable is not public. IPv4-mapped IPv6 addresses are classified by the
 * embedded IPv4 address.
 *
 * @param address - the address to classify.
 * @returns true only for a public unicast destination.
 */
export function isPublicAddress(address) {
  const parsed = parseAddress(address)
  if (parsed === undefined) return false

  if (parsed.family === 4) {
    return !BLOCKED_V4_RANGES.some((range) => addressInRange(address, range))
  }

  // `::ffff:a.b.c.d` is an IPv4 destination wearing an IPv6 spelling.
  const mappedShift = 128n - 96n
  if (parsed.value >> mappedShift === 0xffffn) {
    const embedded = parsed.value & 0xffff_ffffn
    const dotted = [24n, 16n, 8n, 0n].map((shift) => String((embedded >> shift) & 0xffn)).join('.')
    return isPublicAddress(dotted)
  }

  return !BLOCKED_V6_RANGES.some((range) => addressInRange(address, range))
}

/**
 * Strip the brackets WHATWG URL keeps around IPv6 hostnames.
 *
 * @param hostname - a URL hostname.
 * @returns the hostname without surrounding brackets.
 */
export function stripBrackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

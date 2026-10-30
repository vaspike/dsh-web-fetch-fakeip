import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addressInRange,
  isPublicAddress,
  parseAddress,
  parseCidr,
  parseIPv4,
  parseIPv6,
  stripBrackets,
} from '../lib/classify.js'

test('parses IPv4 literals', () => {
  assert.equal(parseIPv4('255.255.255.255'), 0xffff_ffffn)
  assert.equal(parseIPv4('0.0.0.0'), 0n)
  assert.equal(parseIPv4('256.0.0.1'), undefined)
  assert.equal(parseIPv4('1.2.3'), undefined)
  assert.equal(parseIPv4('1.2.3.4.5'), undefined)
})

test('parses IPv6 literals including compression and dotted quads', () => {
  assert.equal(parseIPv6('::'), 0n)
  assert.equal(parseIPv6('::1'), 1n)
  assert.equal(parseIPv6('1:2:3:4:5:6:7:8'), 0x0001_0002_0003_0004_0005_0006_0007_0008n)
  assert.equal(parseIPv6('fe80::1'), 0xfe80_0000_0000_0000_0000_0000_0000_0001n)
  assert.equal(parseIPv6('::ffff:1.2.3.4'), 0x0000_0000_0000_0000_0000_ffff_0102_0304n)
  assert.equal(parseIPv6('1:2:3:4:5:6:7:8:9'), undefined)
  assert.equal(parseIPv6('1:2:3:4:5:6:7::8'), undefined)
  assert.equal(parseIPv6('gggg::1'), undefined)
})

test('parses CIDR blocks and rejects malformed ones', () => {
  assert.deepEqual(parseCidr('198.18.0.0/15'), { family: 4, bits: 15, base: 0xc612_0000n })
  assert.deepEqual(parseCidr('10.0.0.1/8'), { family: 4, bits: 8, base: 0x0a00_0000n })
  assert.deepEqual(parseCidr('::1/128'), { family: 6, bits: 128, base: 1n })
  assert.throws(() => parseCidr('198.18.0.0/33'), /invalid prefix length/)
  assert.throws(() => parseCidr('not-an-address/8'), /does not start with an IP address/)
  assert.throws(() => parseCidr('198.18.0.0/8/1'), /not a CIDR block/)
})

test('matches addresses against ranges', () => {
  const fakeIp = parseCidr('198.18.0.0/15')
  assert.equal(addressInRange('198.18.16.180', fakeIp), true)
  assert.equal(addressInRange('198.19.255.255', fakeIp), true)
  assert.equal(addressInRange('198.20.0.1', fakeIp), false)
  assert.equal(addressInRange('2606:4700::1', fakeIp), false)
})

test('classifies public and reserved IPv4 addresses', () => {
  assert.equal(isPublicAddress('1.1.1.1'), true)
  assert.equal(isPublicAddress('8.8.8.8'), true)
  assert.equal(isPublicAddress('198.18.16.180'), false) // fake-ip
  assert.equal(isPublicAddress('10.1.2.3'), false)
  assert.equal(isPublicAddress('127.0.0.1'), false)
  assert.equal(isPublicAddress('169.254.1.1'), false)
  assert.equal(isPublicAddress('192.168.1.1'), false)
  assert.equal(isPublicAddress('100.64.0.1'), false)
  assert.equal(isPublicAddress('224.0.0.1'), false)
  assert.equal(isPublicAddress('255.255.255.255'), false)
})

test('classifies public and reserved IPv6 addresses', () => {
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
  assert.equal(isPublicAddress('::1'), false)
  assert.equal(isPublicAddress('::'), false)
  assert.equal(isPublicAddress('fe80::1'), false)
  assert.equal(isPublicAddress('fd00::1'), false)
  assert.equal(isPublicAddress('2001:db8::1'), false)
  assert.equal(isPublicAddress('::ffff:1.2.3.4'), true)
  assert.equal(isPublicAddress('::ffff:127.0.0.1'), false)
})

test('reports unparseable addresses as non-public', () => {
  assert.equal(isPublicAddress('github.com'), false)
  assert.equal(parseAddress('github.com'), undefined)
})

test('strips IPv6 brackets', () => {
  assert.equal(stripBrackets('[::1]'), '::1')
  assert.equal(stripBrackets('example.com'), 'example.com')
})

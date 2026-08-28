'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const bits = require('../src/codec/bits')

test('bitOffset counts from the least significant bit of the block', () => {
  // 32 bit block: 0x092B04B1. bitOffset 16 length 16 is the FIRST two octets.
  const buf = Buffer.from([0x09, 0x2b, 0x04, 0xb1])
  assert.equal(bits.readBits(buf, 16, 16), 0x092bn)
  assert.equal(bits.readBits(buf, 0, 1), 1n)
  assert.equal(bits.readBits(buf, 1, 1), 0n)
  assert.equal(bits.readBits(buf, 2, 14), 300n)
})

test('reads fields that straddle octet boundaries', () => {
  const buf = Buffer.from([0b10110011, 0b01011010])
  assert.equal(bits.readBits(buf, 4, 8), 0b00110101n)
  assert.equal(bits.readBits(buf, 7, 3), 0b110n)
})

test('handles values wider than 32 bits', () => {
  const buf = Buffer.from('0123456789abcdef', 'hex')
  assert.equal(bits.readBits(buf, 0, 64), 0x0123456789abcdefn)
  assert.equal(bits.readBits(buf, 32, 32), 0x01234567n)
})

test('two\'s complement sign extension', () => {
  assert.equal(bits.toSigned(0x7fffn, 16), 32767n)
  assert.equal(bits.toSigned(0xffffn, 16), -1n)
  assert.equal(bits.toSigned(0x2000n, 14), -8192n)
  assert.equal(bits.toSigned(0x1fffn, 14), 8191n)
  assert.equal(bits.fromSigned(-1n, 16), 0xffffn)
  assert.equal(bits.fromSigned(-8192n, 14), 0x2000n)
})

test('write is the inverse of read', () => {
  let buf = Buffer.alloc(4)
  buf = bits.writeBits(buf, 16, 16, 0x092bn)
  buf = bits.writeBits(buf, 2, 14, 300n)
  buf = bits.writeBits(buf, 0, 1, 1n)
  assert.equal(buf.toString('hex'), '092b04b1')
})

test('writing one field leaves its neighbours untouched', () => {
  const start = Buffer.from([0xff, 0xff])
  const out = bits.writeBits(start, 4, 4, 0n)
  assert.equal(out.toString('hex'), 'ff0f')
})

test('octet-aligned slices come back in wire order', () => {
  const buf = Buffer.from('deadbeef', 'hex')
  assert.equal(bits.readOctets(buf, 16, 16).toString('hex'), 'dead')
  assert.equal(bits.readOctets(buf, 0, 16).toString('hex'), 'beef')
})

test('rejects reads past the end of the supplied data', () => {
  const buf = Buffer.alloc(2)
  assert.throws(() => bits.readBits(buf, 8, 16), /only 16 were supplied/)
})

test('rejects unaligned octet strings', () => {
  assert.throws(() => bits.readOctets(Buffer.alloc(4), 3, 16), /octet-aligned/)
})

test('accepts hex strings, arrays and buffers as input', () => {
  assert.equal(bits.toBuffer('0A0B').toString('hex'), '0a0b')
  assert.equal(bits.toBuffer('0x0a:0b').toString('hex'), '0a0b')
  assert.equal(bits.toBuffer('0a 0b').toString('hex'), '0a0b')
  assert.equal(bits.toBuffer([10, 11]).toString('hex'), '0a0b')
  assert.equal(bits.toBuffer(Buffer.from([10, 11])).toString('hex'), '0a0b')
  assert.throws(() => bits.toBuffer('xyz'), /not a valid hex string/)
  assert.throws(() => bits.toBuffer('0a0'), /not a valid hex string/)
})

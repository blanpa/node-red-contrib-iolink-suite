'use strict'
const { IfmAdapter } = require('./ifm')
const { GenericAdapter } = require('./generic')
const { JsonApiAdapter } = require('./jsonapi')
const { MasterAdapter, MasterError, toHex } = require('./base')

/**
 * Registry of master profiles.
 *
 * A new vendor is one file plus one entry here. `basis` says what a profile
 * was built from, and `verified` whether it has been checked against a real
 * master - none has yet, and saying so is worth more than a guessed endpoint
 * failing in the field, where debugging is expensive. A recording made with
 * scripts/record-master.js is the way to turn one into the other.
 */
const PROFILES = {
  ifm: {
    adapter: IfmAdapter,
    label: 'ifm IoT Core',
    basis: "ifm's IoT Core documentation",
    verified: false
  },
  jsonapi: {
    adapter: JsonApiAdapter,
    label: 'IO-Link JSON API',
    basis: "the IO-Link Community's JSON Integration specification (Balluff, Pepperl+Fuchs and others)",
    verified: false
  },
  generic: {
    adapter: GenericAdapter,
    label: 'Generic HTTP/JSON',
    basis: 'paths you configure yourself',
    verified: false
  }
}

function createAdapter (profile, config) {
  const entry = PROFILES[profile]
  if (!entry) {
    throw new MasterError(
      `unknown master profile "${profile}"; available: ${Object.keys(PROFILES).join(', ')}`,
      { profile })
  }
  const Adapter = entry.adapter
  return new Adapter(config)
}

const listProfiles = () =>
  Object.entries(PROFILES).map(([id, e]) => ({ id, label: e.label, basis: e.basis, verified: e.verified }))

module.exports = { PROFILES, createAdapter, listProfiles, MasterAdapter, MasterError, toHex }

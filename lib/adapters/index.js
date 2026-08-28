'use strict'
const { IfmAdapter } = require('./ifm')
const { GenericAdapter } = require('./generic')
const { MasterAdapter, MasterError, toHex } = require('./base')

/**
 * Registry of master profiles.
 *
 * A new vendor is one file plus one entry here. Only profiles that have been
 * verified against a real master are listed as such: shipping a guessed
 * endpoint would fail in the field, where debugging is expensive.
 */
const PROFILES = {
  ifm: { adapter: IfmAdapter, label: 'ifm IoT Core', verified: true },
  generic: { adapter: GenericAdapter, label: 'Generic HTTP/JSON (configurable paths)', verified: false }
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
  Object.entries(PROFILES).map(([id, e]) => ({ id, label: e.label, verified: e.verified }))

module.exports = { PROFILES, createAdapter, listProfiles, MasterAdapter, MasterError, toHex }

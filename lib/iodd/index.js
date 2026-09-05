'use strict'
const { parseXml, attr, child, children, pick, intAttr, boolAttr } = require('./xml')
const { buildTexts } = require('./parse/texts')
const { buildDatatypeIndex } = require('./parse/datatypes')
const { buildDisplayIndex } = require('./parse/display')
const { buildProcessData } = require('./parse/processData')
const { buildVariables, indexVariables } = require('./parse/variables')
const { buildEvents } = require('./parse/events')
const { IoddDevice } = require('./device')
const { err, CODES, IoddError } = require('./errors')
const { lookupUnit } = require('./units')
const standard = require('./standard')
const bits = require('./codec/bits')
const { decodeLayout, decodeItem } = require('./codec/decode')
const { encodeLayout, encodeItem } = require('./codec/encode')
const { applyScale, removeScale } = require('./codec/scale')

/** Text-only elements come back as a bare string from the XML layer. */
function textOf (node) {
  if (node === undefined || node === null) return undefined
  if (typeof node === 'string') return node
  return node['#text']
}

function readIdentity (profileBody, texts) {
  const node = child(profileBody, 'DeviceIdentity')
  if (!node) throw err(CODES.PARSE, 'IODD has no DeviceIdentity')
  const variants = children(pick(node, 'DeviceVariantCollection'), 'DeviceVariant').map(v => ({
    productId: attr(v, 'productId'),
    name: texts.nameOf(v, undefined),
    description: texts.descriptionOf(v),
    symbol: attr(v, 'deviceSymbol'),
    icon: attr(v, 'deviceIcon')
  }))
  return {
    vendorId: intAttr(node, 'vendorId'),
    vendorName: attr(node, 'vendorName'),
    deviceId: intAttr(node, 'deviceId'),
    deviceName: texts.get(attr(child(node, 'DeviceName'), 'textId'), undefined),
    deviceFamily: texts.get(attr(child(node, 'DeviceFamily'), 'textId'), undefined),
    vendorText: texts.get(attr(child(node, 'VendorText'), 'textId'), undefined),
    vendorUrl: texts.get(attr(child(node, 'VendorUrl'), 'textId'), undefined),
    variants
  }
}

// <CommNetworkProfile> is a sibling of <ProfileBody> under <IODevice>,
// not a child of it.
function readCommunication (root) {
  const profile = child(root, 'CommNetworkProfile')
  const phy = pick(profile, 'TransportLayers', 'PhysicalLayer')
  return {
    ioLinkRevision: attr(profile, 'iolinkRevision'),
    compatibleWith: attr(profile, 'compatibleWith'),
    bitrate: attr(phy, 'bitrate'),
    // The IODD states minCycleTime in microseconds.
    minCycleTimeUs: intAttr(phy, 'minCycleTime'),
    sioSupported: boolAttr(phy, 'sioSupported'),
    mSequenceCapability: intAttr(phy, 'mSequenceCapability')
  }
}

function readFeatures (deviceFunction) {
  const node = child(deviceFunction, 'Features')
  if (!node) return {}
  const locks = child(node, 'SupportedAccessLocks')
  return {
    blockParameter: boolAttr(node, 'blockParameter'),
    dataStorage: boolAttr(node, 'dataStorage'),
    profileCharacteristic: attr(node, 'profileCharacteristic'),
    supportedAccessLocks: locks
      ? {
          parameter: boolAttr(locks, 'parameter'),
          dataStorage: boolAttr(locks, 'dataStorage'),
          localParameterization: boolAttr(locks, 'localParameterization'),
          localUserInterface: boolAttr(locks, 'localUserInterface')
        }
      : undefined
  }
}

function readDocumentInfo (root, texts) {
  const doc = child(root, 'DocumentInfo')
  const stamp = child(root, 'Stamp')
  return {
    version: attr(doc, 'version'),
    releaseDate: attr(doc, 'releaseDate'),
    copyright: attr(doc, 'copyright'),
    profileRevision: textOf(pick(root, 'ProfileHeader', 'ProfileRevision')),
    crc: attr(stamp, 'crc')
  }
}

/**
 * Parse an IODD document.
 *
 * @param {string|Buffer} xml   the IODD XML (the .xml inside the IODD ZIP)
 * @param {object} [options]
 * @param {string} [options.language='en']  preferred language for names
 * @param {string} [options.keyStyle='preserve'] output key style:
 *        preserve | camel | pascal | snake | kebab
 * @param {object} [options.conditions]  current values of parameters that
 *        select between alternative layouts or scalings, keyed by variable id,
 *        e.g. `{ V_uni: 1 }` to say the device is set to bar
 * @returns {IoddDevice}
 */
function parseIodd (xml, options = {}) {
  const tree = parseXml(xml)
  const root = child(tree, 'IODevice')
  if (!root) {
    throw err(CODES.PARSE, 'not an IODD: no <IODevice> root element')
  }
  const profileBody = child(root, 'ProfileBody')
  const deviceFunction = child(profileBody, 'DeviceFunction')
  if (!profileBody || !deviceFunction) {
    throw err(CODES.PARSE, 'malformed IODD: missing ProfileBody/DeviceFunction')
  }

  const texts = buildTexts(root, options.language || 'en')
  const warnings = []
  const ctx = {
    texts,
    datatypes: buildDatatypeIndex(deviceFunction),
    display: buildDisplayIndex(deviceFunction),
    keyStyle: options.keyStyle || 'preserve',
    conditions: options.conditions || {},
    warnings
  }

  const variables = buildVariables(deviceFunction, ctx)
  ctx.variableIndex = indexVariables(variables)
  for (const v of variables) {
    if (v.unsupported) warnings.push(`parameter ${v.id ?? v.index}: ${v.unsupported}`)
  }

  const processData = buildProcessData(deviceFunction, ctx)

  const device = new IoddDevice({
    conditions: ctx.conditions,
    identity: readIdentity(profileBody, texts),
    communication: readCommunication(root),
    features: readFeatures(deviceFunction),
    document: readDocumentInfo(root, texts),
    processData,
    variables,
    events: buildEvents(deviceFunction, ctx),
    language: {
      requested: options.language || 'en',
      resolved: texts.resolvedLanguage,
      primary: texts.primaryLanguage,
      available: texts.languages
    },
    warnings
  })

  if (processData.length > 1) {
    warnings.push(
      `device declares ${processData.length} process data layouts; select one via ` +
      '{ variant } or { conditions } before decoding')
  }
  return device
}

/** Decode raw process data against a layout produced by `parseIodd`. */
function decode (raw, layout, opts) {
  return decodeLayout(raw, layout, opts)
}

/** Encode values into raw process data for a layout produced by `parseIodd`. */
function encode (values, layout, opts) {
  return encodeLayout(values, layout, opts)
}

module.exports = {
  parseIodd,
  decode,
  encode,
  IoddDevice,
  IoddError,
  ERROR_CODES: CODES,
  lookupUnit,
  lookupEvent: standard.lookupEvent,
  lookupStandardVariable: standard.lookupStandardVariable,
  DEVICE_STATUS: standard.DEVICE_STATUS,
  decodeEventQualifier: standard.decodeEventQualifier,
  decodeDetailedDeviceStatus: standard.decodeDetailedDeviceStatus,
  encodeEventQualifier: standard.encodeEventQualifier,
  encodeDetailedDeviceStatus: standard.encodeDetailedDeviceStatus,
  // Lower-level pieces, useful when driving the codec directly.
  bits,
  decodeLayout,
  decodeItem,
  encodeLayout,
  encodeItem,
  applyScale,
  removeScale
}

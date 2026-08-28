'use strict'
/**
 * Objects the IO-Link specification defines for every device, which IODD files
 * therefore reference instead of defining.
 *
 * Transcribed from "IO-Link Interface and System Specification" V1.1.3
 * (June 2019), Table B.8 (index assignment), Table D.1 (device EventCodes) and
 * Table D.2 (port EventCodes). Ranges marked reserved or vendor specific in the
 * spec are resolved at lookup time rather than enumerated here.
 */

/** Table B.8 - standard ISDU objects, keyed by the id IODD uses to reference them. */
const STANDARD_VARIABLES = {
  V_DirectParameters_1: { index: 0, name: 'Direct Parameter Page 1', access: 'ro', type: 'Record' },
  V_DirectParameters_2: { index: 1, name: 'Direct Parameter Page 2', access: 'rw', type: 'Record' },
  V_SystemCommand: { index: 2, name: 'SystemCommand', access: 'wo', type: 'UInteger', bitLength: 8 },
  V_Data_Storage: { index: 3, name: 'Data Storage', access: 'rw', type: 'Record' },
  V_DeviceAccessLocks: { index: 12, name: 'DeviceAccessLocks', access: 'rw', type: 'Record', bitLength: 16 },
  V_ProfileCharacteristic: { index: 13, name: 'ProfileCharacteristic', access: 'ro', type: 'Array' },
  V_PDInputDescriptor: { index: 14, name: 'PDInputDescriptor', access: 'ro', type: 'Array' },
  V_PDOutputDescriptor: { index: 15, name: 'PDOutputDescriptor', access: 'ro', type: 'Array' },
  V_VendorName: { index: 16, name: 'VendorName', access: 'ro', type: 'String', octetLength: 64 },
  V_VendorText: { index: 17, name: 'VendorText', access: 'ro', type: 'String', octetLength: 64 },
  V_ProductName: { index: 18, name: 'ProductName', access: 'ro', type: 'String', octetLength: 64 },
  V_ProductID: { index: 19, name: 'ProductID', access: 'ro', type: 'String', octetLength: 64 },
  V_ProductText: { index: 20, name: 'ProductText', access: 'ro', type: 'String', octetLength: 64 },
  V_SerialNumber: { index: 21, name: 'SerialNumber', access: 'ro', type: 'String', octetLength: 16 },
  V_HardwareRevision: { index: 22, name: 'HardwareRevision', access: 'ro', type: 'String', octetLength: 64 },
  V_FirmwareRevision: { index: 23, name: 'FirmwareRevision', access: 'ro', type: 'String', octetLength: 64 },
  V_ApplicationSpecificTag: { index: 24, name: 'ApplicationSpecificTag', access: 'rw', type: 'String', octetLength: 32 },
  // IODD 1.0.1 named the object at index 24 "ApplicationSpecificName".
  V_ApplicationSpecificName: { index: 24, name: 'ApplicationSpecificName', access: 'rw', type: 'String', octetLength: 32 },
  V_FunctionTag: { index: 25, name: 'FunctionTag', access: 'rw', type: 'String', octetLength: 32 },
  V_LocationTag: { index: 26, name: 'LocationTag', access: 'rw', type: 'String', octetLength: 32 },
  V_ErrorCount: { index: 32, name: 'ErrorCount', access: 'ro', type: 'UInteger', bitLength: 16 },
  V_DeviceStatus: { index: 36, name: 'DeviceStatus', access: 'ro', type: 'UInteger', bitLength: 8 },
  V_DetailedDeviceStatus: { index: 37, name: 'DetailedDeviceStatus', access: 'ro', type: 'Array' },
  V_ProcessDataInput: { index: 40, name: 'ProcessDataInput', access: 'ro', type: 'Device specific' },
  V_ProcessDataIn: { index: 40, name: 'ProcessDataInput', access: 'ro', type: 'Device specific' },
  V_ProcessDataOutput: { index: 41, name: 'ProcessDataOutput', access: 'ro', type: 'Device specific' },
  V_ProcessDataOut: { index: 41, name: 'ProcessDataOutput', access: 'ro', type: 'Device specific' },
  V_OffsetTime: { index: 48, name: 'OffsetTime', access: 'rw', type: 'Record' }
}

/** B.2.20 - DeviceStatus (index 36) values. */
const DEVICE_STATUS = {
  0: 'Device is OK',
  1: 'Maintenance required',
  2: 'Out of specification',
  3: 'Functional check',
  4: 'Failure'
}

/** Table D.1 - EventCodes reported by devices (source REMOTE). */
const DEVICE_EVENTS = {
  0x0000: ['No malfunction', 'Notification', 0],
  0x1000: ['General malfunction - unknown error', 'Error', 4],
  0x4000: ['Temperature fault - Overload', 'Error', 4],
  0x4210: ['Device temperature overrun - Clear source of heat', 'Warning', 2],
  0x4220: ['Device temperature underrun - Insulate device', 'Warning', 2],
  0x5000: ['Device hardware fault - Device exchange', 'Error', 4],
  0x5010: ['Component malfunction - Repair or exchange', 'Error', 4],
  0x5011: ['Non volatile memory loss - Check batteries', 'Error', 4],
  0x5012: ['Batteries low - Exchange batteries', 'Warning', 2],
  0x5100: ['General power supply fault - Check availability', 'Error', 4],
  0x5101: ['Fuse blown/open - Exchange fuse', 'Error', 4],
  0x5110: ['Primary supply voltage overrun - Check tolerance', 'Warning', 2],
  0x5111: ['Primary supply voltage underrun - Check tolerance', 'Warning', 2],
  0x5112: ['Secondary supply voltage fault (Port Class B) - Check tolerance', 'Warning', 2],
  0x6000: ['Device software fault - Check firmware revision', 'Error', 4],
  0x6320: ['Parameter error - Check data sheet and values', 'Error', 4],
  0x6321: ['Parameter missing - Check data sheet', 'Error', 4],
  0x7700: ['Wire break of a subordinate device - Check installation', 'Error', 4],
  0x7710: ['Short circuit - Check installation', 'Error', 4],
  0x7711: ['Ground fault - Check installation', 'Error', 4],
  0x8C00: ['Technology specific application fault - Reset device', 'Error', 4],
  0x8C01: ['Simulation active - Check operational mode', 'Warning', 3],
  0x8C10: ['Process variable range overrun - Process data uncertain', 'Warning', 2],
  0x8C20: ['Measurement range exceeded - Check application', 'Error', 4],
  0x8C30: ['Process variable range underrun - Process data uncertain', 'Warning', 2],
  0x8C40: ['Maintenance required - Cleaning', 'Warning', 1],
  0x8C41: ['Maintenance required - Refill', 'Warning', 1],
  0x8C42: ['Maintenance required - Exchange wear and tear parts', 'Warning', 1],
  0xFF91: ['Data Storage upload request', 'Notification', 0]
}

/** Table D.2 - EventCodes reported by the master for a port. */
const PORT_EVENTS = {
  0x1800: ['No device (communication)', 'Error'],
  0x1801: ['Startup parametrization error - check parameter', 'Error'],
  0x1802: ['Incorrect VendorID - inspection level mismatch', 'Error'],
  0x1803: ['Incorrect DeviceID - inspection level mismatch', 'Error'],
  0x1804: ['Short circuit at C/Q - check wire connection', 'Error'],
  0x1805: ['PHY overtemperature - check master temperature and load', 'Error'],
  0x1806: ['Short circuit at L+ - check wire connection', 'Error'],
  0x1807: ['Overcurrent at L+ - check power supply', 'Error'],
  0x1808: ['Device event overflow', 'Error'],
  0x1809: ['Backup inconsistency - memory out of range', 'Error'],
  0x180A: ['Backup inconsistency - identity fault', 'Error'],
  0x180B: ['Backup inconsistency - data storage unspecific error', 'Error'],
  0x180C: ['Backup inconsistency - upload fault', 'Error'],
  0x180D: ['Parameter inconsistency - download fault', 'Error'],
  0x180E: ['P24 (Class B) missing or undervoltage', 'Error'],
  0x180F: ['Short circuit at P24 (Class B) - check wire connection', 'Error'],
  0x1810: ['Short circuit at I/Q - check wiring', 'Error'],
  0x1811: ['Short circuit at C/Q (if digital output) - check wiring', 'Error'],
  0x1812: ['Overcurrent at I/Q - check load', 'Error'],
  0x1813: ['Overcurrent at C/Q (if digital output) - check load', 'Error'],
  0x6000: ['Invalid cycle time', 'Error'],
  0x6001: ['Revision fault - incompatible protocol version', 'Error'],
  0x6002: ['ISDU batch failed - parameter inconsistency', 'Error'],
  0xFF21: ['Device plugged in', 'Notification'],
  0xFF22: ['Device communication lost', 'Notification'],
  0xFF23: ['Data storage identification mismatch', 'Notification'],
  0xFF24: ['Data storage buffer overflow', 'Notification'],
  0xFF25: ['Data storage parameter access denied', 'Notification'],
  0xFF26: ['Port status changed', 'Notification'],
  0xFF27: ['Data storage upload completed, new data object available', 'Notification'],
  0xFF31: ['Incorrect event signalling', 'Notification']
}

const inRange = (code, lo, hi) => code >= lo && code <= hi

/**
 * Resolve an EventCode.
 * `scope` is 'device' (Table D.1) or 'port' (Table D.2).
 */
function lookupEvent (code, scope = 'device') {
  const n = Number(code)
  if (!Number.isInteger(n)) return null
  const table = scope === 'port' ? PORT_EVENTS : DEVICE_EVENTS
  const hit = table[n]
  const hex = '0x' + n.toString(16).toUpperCase().padStart(4, '0')
  if (hit) {
    const out = { code: n, hex, name: hit[0], type: hit[1], scope }
    if (hit[2] !== undefined) out.deviceStatus = hit[2]
    return out
  }
  // Ranges the spec leaves to the vendor or to other specifications.
  const vendorRange = scope === 'port'
    ? inRange(n, 0x1F00, 0x1FFF)
    : inRange(n, 0x1800, 0x18FF) || inRange(n, 0x8CA0, 0x8DFF)
  if (vendorRange) {
    return { code: n, hex, name: undefined, type: undefined, scope, vendorSpecific: true }
  }
  if (scope === 'device' && inRange(n, 0xB000, 0xB0FF)) {
    return { code: n, hex, scope, name: 'Reserved for safety extensions', type: undefined }
  }
  if (scope === 'device' && inRange(n, 0xB100, 0xBFFF)) {
    return { code: n, hex, scope, name: 'Reserved for profiles', type: undefined }
  }
  return { code: n, hex, scope, name: undefined, type: undefined, reserved: true }
}

/** Resolve a StdVariableRef id to its specified index and shape. */
function lookupStandardVariable (id) {
  const hit = STANDARD_VARIABLES[id]
  return hit ? { id, ...hit, standard: true } : null
}

module.exports = {
  STANDARD_VARIABLES,
  DEVICE_EVENTS,
  PORT_EVENTS,
  DEVICE_STATUS,
  lookupEvent,
  lookupStandardVariable
}

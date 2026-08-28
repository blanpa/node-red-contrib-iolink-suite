# The IODD decoder

`lib/iodd/` is the IODD parser and the IO-Link process data codec the nodes are
built on. It has no Node-RED dependency and one runtime dependency
(`fast-xml-parser`), so it is usable from any Node.js program — if your process
data reaches you over PROFINET, Modbus, OPC UA or anything else, hand it the raw
bytes and the IODD and get engineering values back.

```js
const { parseIodd } = require('node-red-contrib-iolink-suite')   // or require('./lib/iodd')

const device = parseIodd(fs.readFileSync('ifm-PV2304-IODD1.1.xml'), {
  language: 'de',
  conditions: { V_uni: 1 }        // device is configured to bar
})

device.decodeIn('13880003')
// {
//   payload: { Pressure: 5, OUT2: true, OUT1: true },
//   meta: { Pressure: { type: 'Integer', unit: 'bar', min: -1, max: 10.5, raw: 5000, ... } }
// }
```

## Why the metadata is not on the datatype

The single most common way to get IODD decoding wrong is to read scaling off the
datatype. The datatype only says *16 bit signed*. That a raw `2347` means
`23.47 °C` is stated in `<UserInterface>`, and in two different places depending
on the vendor:

* `<ProcessDataRefCollection>` → `<ProcessDataRef processDataId="...">` →
  `<ProcessDataRecordItemInfo subindex=".." gradient=".." unitCode="..">`.
  `processDataId` names a `ProcessDataIn`/`ProcessDataOut` element — never the
  `<ProcessData>` wrapper around it.
* Nothing there at all, and instead `<RecordItemRef variableId="V_ProcessDataInput"
  subindex=".." gradient="..">` inside a role menu, because ISDU index 40 mirrors
  the process data input. Whole ifm product families are written this way.

This library reads both.

## Ambiguity is reported, never guessed

Two things in real IODDs depend on how the device is currently parameterised:

**The layout itself.** A sensor may declare several `<ProcessData>` blocks, each
guarded by a `<Condition>` on a parameter. Decoding with the wrong one yields
plausible, wrong numbers, so an unselected layout is an error:

```
IODD_AMBIGUOUS_VARIANT: SICK AG DT35-B15851 has 7 process data layouts and none
was selected. Pass { variant: "<id>" } or the current parameter value via
{ conditions: { ... } }. Candidates: PD_ProcessData1 (when V_ProcessDataSelect = 0); ...
```

**The scaling.** The same value is often described once per display unit
(bar / MPa / psi, °C / °F), in menus selected by a parameter. Without that
parameter the value is returned **raw and unscaled**, the alternatives are listed
on the item as `scalingAmbiguous`, and a warning is recorded — rather than
silently reporting psi as bar.

Supply the parameter and both resolve:

```js
parseIodd(xml, { conditions: { V_ProcessDataSelect: 2, V_uni: 1 } })
```

## Bit addressing

Process data is a big-endian octet string, and IODD `bitOffset` counts from the
**least significant bit of the whole block** — the right-hand end of the last
octet — growing leftwards. In a 32-bit block, `bitOffset="16" bitLength="16"` is
the *first* two octets on the wire. Blocks whose bit length is not a multiple of
8 are right-aligned with the padding in the most significant bits.

## API

### `parseIodd(xml, options?) → IoddDevice`

| option | default | meaning |
| --- | --- | --- |
| `language` | `'en'` | preferred language; falls back per string to the primary language |
| `keyStyle` | `'preserve'` | `preserve`, `camel`, `pascal`, `snake`, `kebab` — output key style |
| `conditions` | `{}` | current parameter values, keyed by variable id, that select layouts and scalings |

### `IoddDevice`

| member | description |
| --- | --- |
| `identity` | vendorId, deviceId, vendor/device names, product variants |
| `communication` | IO-Link revision, bitrate, `minCycleTimeUs`, SIO support |
| `processData` | every declared layout with its selecting condition |
| `variants` | compact summary of the above |
| `variables` | ISDU parameters, vendor-defined and standard (index, access, range, unit, enums) |
| `events` | declared events, resolved against the specification's EventCode tables |
| `warnings` | non-fatal findings collected while parsing |
| `layout(direction, opts?)` | the selected `'in'` or `'out'` layout |
| `decodeIn(raw, opts?)` / `decodeOut(raw, opts?)` | `{ payload, meta }` |
| `encodeOut(values, opts?)` | `Buffer` |
| `variable(idOrIndexOrName)` | look up one ISDU parameter |
| `event(code)` | look up one event |

`raw` accepts a `Buffer`, a byte array, or a hex string (`'13880003'`,
`'13 88 00 03'`, `'0x1388...'`).

Decode options: `enums: 'text'` puts resolved enum words in the payload,
`octets: 'hex'|'buffer'|'array'|'base64'`, `strictLength`, `partial`, `bigInt`.
Encode options: `base` (seed with the device's current output so one field can be
changed in isolation), `ignoreUnknown`, `ignoreRange`.

### `IoddFinder`

Looks IODDs up on [IODDfinder](https://ioddfinder.io-link.com) by the vendorId and
deviceId a device reports over the wire, and caches them locally. The cache is
tried first, and a failed request falls back to it — shop floors are offline more
often than not. IODD ZIPs can also be imported by hand.

```js
const { IoddFinder } = require('node-red-contrib-iolink-suite/lib/iodd/finder')
const finder = new IoddFinder({ cacheDir: '/data/iodd-cache' })

const { device, source } = await finder.load({ vendorId: 310, deviceId: 377 })
await finder.importPackage('/mnt/usb/vendor-iodd.zip')   // ZIP, path, or raw XML
```

### Errors

Every error is an `IoddError` with a stable `code`: `IODD_PARSE`,
`IODD_UNSUPPORTED`, `IODD_AMBIGUOUS_VARIANT`, `IODD_BROKEN_REF`, `IODD_DECODE`,
`IODD_NOT_FOUND`, `IODD_OFFLINE`,
`IODD_ENCODE`.

## Supported

Datatypes `BooleanT`, `UIntegerT`, `IntegerT`, `Float32T`, `StringT`,
`OctetStringT`, `TimeSpanT`, `TimeT`, `ArrayT`, `RecordT`, and `DatatypeRef` into
`DatatypeCollection`. Conditional process data. Multi-language texts. `SingleValue`
enums and `ValueRange` bounds (reported in engineering units, not raw counts). All
607 standard unit codes. The specification's standard ISDU objects and both
EventCode tables.

**Not supported:** a `RecordT` or `ArrayT` nested inside a `RecordItem` — legal,
vanishingly rare, and vendors disagree about the bit layout, so it raises
`IODD_UNSUPPORTED` rather than producing a guess. `TimeSpanT`/`TimeT` decode to
the raw 64-bit integer, since the IODD carries no resolution for them.

## Reference data

Generated and transcribed from primary sources, not from memory:

* **Unit codes** — `lib/iodd/units.js`, generated by `npm run gen:units` from the OPC
  Foundation's normative [EngineeringUnits.csv](https://www.opcfoundation.org/UA/schemas/IOLink/1.0/EngineeringUnits.csv)
  (Annex C of *OPC UA for IO-Link Devices and IO-Link Masters*).
* **Standard ISDU objects and EventCodes** — `lib/iodd/standard.js`, from Tables B.8,
  D.1 and D.2 of the *IO-Link Interface and System Specification* V1.1.3.

## Corpus tests

```bash
npm run corpus    # download real vendor IODDs into test/corpus/
npm test          # now also runs the corpus tests
```

The corpus is the point. `npm run corpus` pulls IODDs spread across ~30 vendors
from IODDfinder and the suite then checks that each one parses, that every process
data layout is internally consistent, that every layout decodes, and that every
output layout survives an encode/decode round trip. Vendor IODDs are copyrighted,
so they are downloaded on demand and never committed.


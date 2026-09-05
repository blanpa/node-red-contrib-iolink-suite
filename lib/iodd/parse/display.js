'use strict'
const { attr, child, children, floatAttr, intAttr, ATTR } = require('../xml')
const { lookupUnit } = require('../units')

/**
 * Scaling and unit metadata lives in <UserInterface>, NOT on the datatype.
 *
 * A datatype only says "16 bit signed"; the fact that a raw 2347 means
 * 23.47 °C is carried by gradient/offset/unitCode attributes in the user
 * interface. Two placements occur in the wild:
 *
 *  1. <ProcessDataRefCollection><ProcessDataRef processDataId=".."> with
 *     <ProcessDataRecordItemInfo subindex=".." gradient=".." unitCode="..">.
 *     processDataId names a ProcessDataIn/Out element, not the wrapper.
 *
 *  2. Nothing at all in ProcessDataRefCollection, and instead
 *     <RecordItemRef variableId="V_ProcessDataInput" subindex=".." gradient="..">
 *     inside a role menu - because index 40 mirrors the process data input.
 *     ifm ships whole families like this.
 *
 * In form 2 the same subindex is often described several times with different
 * units (bar / MPa / psi), each inside a menu selected by
 * <MenuRef><Condition variableId="V_uni" value=".."/></MenuRef>. Which one
 * applies depends on how the device is parameterised, so every candidate is
 * kept together with the conditions that select it. Picking one blindly would
 * silently report psi values as bar.
 */

const PD_MIRROR = {
  in: ['V_ProcessDataInput', 'V_ProcessDataIn'],
  out: ['V_ProcessDataOutput', 'V_ProcessDataOut']
}

/** displayFormat is "Dec", "Dec.2", "Bin", "Hex" - the digits drive rounding. */
function decimalsFrom (displayFormat) {
  if (!displayFormat) return null
  const m = /^Dec\.(\d+)$/.exec(displayFormat)
  return m ? Number(m[1]) : null
}

function readInfo (node) {
  const gradient = floatAttr(node, 'gradient')
  const offset = floatAttr(node, 'offset')
  const unitCode = intAttr(node, 'unitCode')
  const displayFormat = attr(node, 'displayFormat')
  const accessRightRestriction = attr(node, 'accessRightRestriction')
  const info = {}
  if (gradient !== undefined) info.gradient = gradient
  if (offset !== undefined) info.offset = offset
  if (unitCode !== undefined) {
    info.unitCode = unitCode
    const unit = lookupUnit(unitCode)
    if (unit) { info.unit = unit.symbol; info.unitName = unit.name }
  }
  if (displayFormat !== undefined) {
    info.displayFormat = displayFormat
    const d = decimalsFrom(displayFormat)
    if (d !== null) info.decimals = d
  }
  if (accessRightRestriction !== undefined) info.accessRightRestriction = accessRightRestriction
  return Object.keys(info).length ? info : null
}

/** Only these fields change how a raw count is interpreted. */
const SCALING_FIELDS = ['gradient', 'offset', 'unitCode', 'displayFormat']
const scalingKey = info =>
  SCALING_FIELDS.map(f => (info && info[f] !== undefined ? String(info[f]) : '')).join('|')
const hasScaling = info => info && SCALING_FIELDS.some(f => info[f] !== undefined)

/** Depth-first walk yielding every element node with the given local name. */
function * findAll (node, name) {
  if (!node || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith(ATTR)) continue
    const local = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
    const list = Array.isArray(value) ? value : [value]
    for (const entry of list) {
      if (local === name) yield entry
      if (entry && typeof entry === 'object') yield * findAll(entry, name)
    }
  }
}

function readCondition (node) {
  const cond = child(node, 'Condition')
  if (!cond) return null
  return {
    variableId: attr(cond, 'variableId'),
    subindex: intAttr(cond, 'subindex'),
    value: attr(cond, 'value')
  }
}

/**
 * Work out, for every menu, under which condition chains it is reachable.
 * A menu reached by several routes gets several chains.
 */
function menuConditionChains (ui) {
  const menus = new Map()
  for (const menu of findAll(child(ui, 'MenuCollection'), 'Menu')) {
    const id = attr(menu, 'id')
    if (id !== undefined) menus.set(id, menu)
  }

  const chains = new Map()
  const addChain = (id, chain) => {
    let list = chains.get(id)
    if (!list) { list = []; chains.set(id, list) }
    const key = chain.map(c => `${c.variableId}:${c.subindex ?? ''}=${c.value}`).join(',')
    if (!list.some(c => c.key === key)) list.push({ key, chain })
  }

  const walk = (id, chain, seen) => {
    if (seen.has(id)) return
    addChain(id, chain)
    const menu = menus.get(id)
    if (!menu) return
    const nextSeen = new Set(seen).add(id)
    for (const ref of children(menu, 'MenuRef')) {
      const target = attr(ref, 'menuId')
      if (target === undefined) continue
      const cond = readCondition(ref)
      walk(target, cond ? chain.concat(cond) : chain, nextSeen)
    }
  }

  // Role menu sets are the roots the tooling enters through.
  const roots = new Set()
  for (const name of ['ObserverRoleMenuSet', 'MaintenanceRoleMenuSet', 'SpecialistRoleMenuSet']) {
    for (const set of findAll(ui, name)) {
      for (const kind of ['IdentificationMenu', 'ParameterMenu', 'ObservationMenu', 'DiagnosisMenu']) {
        for (const entry of children(set, kind)) {
          const id = attr(entry, 'menuId')
          if (id !== undefined) roots.add(id)
        }
      }
    }
  }
  for (const id of roots) walk(id, [], new Set())
  // Menus no role set reaches still carry usable metadata; treat as unconditional.
  for (const id of menus.keys()) if (!chains.has(id)) addChain(id, [])
  return { menus, chains }
}

function entry (map, id) {
  let e = map.get(id)
  if (!e) { e = { self: [], bySubindex: new Map() }; map.set(id, e) }
  return e
}

function pushCandidate (list, info, conditions) {
  if (!info) return
  const key = scalingKey(info) + '#' + conditions.map(c => `${c.variableId}=${c.value}`).join(',')
  if (list.some(c => c.key === key)) return
  list.push({ key, info, conditions })
}

/**
 * Build candidate tables for display metadata.
 * Returns `{ processData, variables }`, each Map<id, { self: [], bySubindex: Map<number, []> }>.
 */
function buildDisplayIndex (deviceFunction) {
  const ui = child(deviceFunction, 'UserInterface')
  const processData = new Map()
  const variables = new Map()
  if (!ui) return { processData, variables }

  // Form 1: explicit process data references (never conditional).
  for (const ref of findAll(ui, 'ProcessDataRef')) {
    const id = attr(ref, 'processDataId')
    if (id === undefined) continue
    const e = entry(processData, id)
    for (const info of children(ref, 'ProcessDataInfo')) {
      pushCandidate(e.self, readInfo(info), [])
    }
    for (const info of children(ref, 'ProcessDataRecordItemInfo')) {
      const subindex = intAttr(info, 'subindex')
      if (subindex === undefined) { pushCandidate(e.self, readInfo(info), []); continue }
      if (!e.bySubindex.has(subindex)) e.bySubindex.set(subindex, [])
      pushCandidate(e.bySubindex.get(subindex), readInfo(info), [])
    }
  }

  // Form 2: variable references inside menus, carrying the menu's conditions.
  const { menus, chains } = menuConditionChains(ui)
  for (const [menuId, menu] of menus) {
    const menuChains = chains.get(menuId) || [{ chain: [] }]
    for (const { chain } of menuChains) {
      for (const ref of children(menu, 'VariableRef')) {
        const id = attr(ref, 'variableId')
        if (id === undefined) continue
        pushCandidate(entry(variables, id).self, readInfo(ref), chain)
      }
      for (const ref of children(menu, 'RecordItemRef')) {
        const id = attr(ref, 'variableId')
        const subindex = intAttr(ref, 'subindex')
        if (id === undefined || subindex === undefined) continue
        const e = entry(variables, id)
        if (!e.bySubindex.has(subindex)) e.bySubindex.set(subindex, [])
        pushCandidate(e.bySubindex.get(subindex), readInfo(ref), chain)
      }
    }
  }

  return { processData, variables }
}

/**
 * Choose one metadata candidate.
 *
 * `conditions` maps variableId (or index) to the value the device is currently
 * parameterised with. The most specific chain that matches wins; candidates
 * with an unmatched condition are discarded. When several remain and they
 * disagree about scaling, none is chosen and the alternatives are reported so
 * the caller can decide instead of trusting a coin flip.
 */
function resolveCandidates (candidates, conditions = {}) {
  if (!candidates || !candidates.length) return { info: null }

  const supplied = key => conditions[key]
  const eligible = candidates.filter(c =>
    c.conditions.every(cond => {
      const given = supplied(cond.variableId)
      if (given === undefined) return false
      return String(given) === String(cond.value)
    }))

  const unconditional = candidates.filter(c => c.conditions.length === 0)
  const pool = eligible.length ? eligible : unconditional
  if (!pool.length) {
    // Everything is conditional and nothing was supplied.
    const scaled = candidates.filter(c => hasScaling(c.info))
    if (!scaled.length) return { info: null }
    const distinct = new Set(scaled.map(c => scalingKey(c.info)))
    if (distinct.size === 1) return { info: scaled[0].info }
    return { info: null, alternatives: scaled.map(describe) }
  }

  const withScaling = pool.filter(c => hasScaling(c.info))
  const chosen = withScaling.length ? withScaling : pool
  const distinct = new Set(chosen.map(c => scalingKey(c.info)))
  if (distinct.size === 1) {
    // Merge so an accessRightRestriction from one entry is not lost.
    return { info: chosen.reduce((acc, c) => ({ ...c.info, ...acc }), {}) }
  }
  // Prefer the most specific matching chain before giving up.
  const maxDepth = Math.max(...chosen.map(c => c.conditions.length))
  const deepest = chosen.filter(c => c.conditions.length === maxDepth)
  if (new Set(deepest.map(c => scalingKey(c.info))).size === 1) return { info: deepest[0].info }
  return { info: null, alternatives: chosen.map(describe) }
}

function describe (candidate) {
  const out = {}
  for (const f of SCALING_FIELDS) if (candidate.info[f] !== undefined) out[f] = candidate.info[f]
  if (candidate.info.unit !== undefined) out.unit = candidate.info.unit
  if (candidate.conditions.length) out.when = candidate.conditions.map(c => ({ ...c }))
  return out
}

/** The candidate list for one item, falling back to the index 40/41 mirror. */
function candidatesFor (display, layoutId, direction, subindex) {
  const direct = display.processData.get(layoutId)
  if (direct) {
    const own = (subindex !== undefined && direct.bySubindex.get(subindex)) || direct.self
    if (own && own.length) return own
  }
  for (const mirrorId of PD_MIRROR[direction] || []) {
    const mirror = display.variables.get(mirrorId)
    if (!mirror) continue
    const own = (subindex !== undefined && mirror.bySubindex.get(subindex)) || mirror.self
    if (own && own.length) return own
  }
  return []
}

module.exports = {
  buildDisplayIndex, resolveCandidates, candidatesFor, decimalsFrom, findAll, PD_MIRROR
}

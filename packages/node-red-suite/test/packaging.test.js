'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const pkg = require('../package.json')

/**
 * Node-RED loads nodes from the `node-red` block in package.json, and the
 * editor half from the .html beside each .js. A mismatch there does not fail
 * any unit test - it fails silently at install time on someone else's machine,
 * with the node simply missing from the palette.
 */
const root = path.join(__dirname, '..')
const declared = Object.entries(pkg['node-red'].nodes)

test('every declared node file exists', () => {
  for (const [name, file] of declared) {
    assert.ok(fs.existsSync(path.join(root, file)), `${name}: missing ${file}`)
    assert.ok(fs.existsSync(path.join(root, file.replace(/\.js$/, '.html'))),
      `${name}: missing editor html for ${file}`)
  }
})

test('every node module exports a registration function', () => {
  for (const [, file] of declared) {
    const mod = require(path.join(root, file))
    assert.equal(typeof mod, 'function', `${file} must export function (RED) {...}`)
  }
})

test('each node registers the type it is declared under', () => {
  for (const [name, file] of declared) {
    const js = fs.readFileSync(path.join(root, file), 'utf8')
    assert.match(js, new RegExp(`registerType\\(\\s*['"]${name}['"]`),
      `${file} should register the type "${name}"`)
    const html = fs.readFileSync(path.join(root, file.replace(/\.js$/, '.html')), 'utf8')
    assert.match(html, new RegExp(`RED\\.nodes\\.registerType\\(\\s*['"]${name}['"]`),
      `the editor half of ${name} should register it too`)
    assert.match(html, new RegExp(`data-template-name=["']${name}["']`),
      `${name} needs an edit template`)
    assert.match(html, new RegExp(`data-help-name=["']${name}["']`),
      `${name} needs help text; it is the only documentation most users read`)
  }
})

test('the html files declare no node type that the package does not ship', () => {
  const names = new Set(declared.map(([name]) => name))
  for (const file of fs.readdirSync(path.join(root, 'nodes')).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(root, 'nodes', file), 'utf8')
    for (const match of html.matchAll(/RED\.nodes\.registerType\(\s*['"]([\w-]+)['"]/g)) {
      assert.ok(names.has(match[1]), `${file} registers "${match[1]}", which package.json omits`)
    }
  }
})

test('the files list covers everything the nodes need at runtime', () => {
  // Publishing without lib/ would ship a package that cannot even be loaded.
  for (const needed of ['lib/', 'nodes/']) {
    assert.ok(pkg.files.includes(needed), `package.json "files" must include ${needed}`)
  }
  for (const entry of pkg.files) {
    assert.ok(fs.existsSync(path.join(root, entry.replace(/\/$/, ''))),
      `package.json lists "${entry}", which does not exist`)
  }
})

test('the runtime dependency on the parser is declared', () => {
  assert.ok(pkg.dependencies['iodd-parser'], 'iodd-parser must be a runtime dependency')
  // The nodes are the only place a Node-RED dependency may appear, and even
  // there only as a peer/engine statement - never as a runtime dependency.
  assert.equal(pkg.dependencies['node-red'], undefined)
  assert.ok(pkg['node-red'].version, 'declare the minimum Node-RED version')
})

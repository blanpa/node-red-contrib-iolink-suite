#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/**
 * Lint the editor halves of the nodes.
 *
 * `standard` reads .js files, and the editor code lives inside <script> tags in
 * the .html - so the least-covered code in the package was also the only code
 * nothing checked. This pulls each script block out into a temporary .js and
 * lints that, then maps the line numbers back to the .html so a complaint
 * points at the file the author has open.
 */
const root = path.join(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iolink-editors-'))
const sources = []

for (const name of fs.readdirSync(path.join(root, 'nodes')).filter(f => f.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(root, 'nodes', name), 'utf8')
  // Only the runtime script blocks: the others hold HTML templates and help.
  const pattern = /<script type="text\/javascript">\n([\s\S]*?)<\/script>/g
  let index = 0
  for (const match of html.matchAll(pattern)) {
    const before = html.slice(0, match.index)
    const firstLine = before.split('\n').length + 1
    const file = path.join(dir, `${name.replace(/\.html$/, '')}.${index++}.js`)
    // The block sits indented inside the html. Left as it is, every line would
    // be reported as over-indented and the real complaints would be lost in
    // the noise, so strip the common indent and put it back on the columns.
    const lines = match[1].split('\n')
    const indent = Math.min(...lines
      .filter(l => l.trim())
      .map(l => l.match(/^ */)[0].length))
    // The blocks run in the editor, where RED, $ and jQuery are globals.
    fs.writeFileSync(file,
      '/* global RED, $ */\n' + lines.map(l => l.slice(indent)).join('\n'))
    sources.push({ file, name, firstLine, offset: 1, indent })
  }
}

if (!sources.length) {
  console.error('no editor script blocks found - has the html layout changed?')
  process.exit(1)
}

try {
  execFileSync(path.join(root, 'node_modules', '.bin', 'standard'),
    sources.map(s => s.file), { stdio: 'pipe', cwd: root })
  console.log(`editor scripts: ${sources.length} blocks, no problems`)
} catch (e) {
  const output = String(e.stdout || '') + String(e.stderr || '')
  // Rewrite "…/iolink-read.0.js:12:3" as "nodes/iolink-read.html:57:3".
  const mapped = output.replace(/(\S+?)\.(\d+)\.js:(\d+):(\d+)/g, (whole, base, _i, line, col) => {
    const hit = sources.find(s => s.file === `${base}.${_i}.js`)
    if (!hit) return whole
    return `nodes/${hit.name}:${hit.firstLine + Number(line) - hit.offset - 1}:${Number(col) + hit.indent}`
  })
  process.stdout.write(mapped)
  process.exit(1)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

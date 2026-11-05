// A small stand-in for `tap`, so the project's own tests run in the sandbox, where npm can't install anything.
// It has only what node-semver's tests call, and it prints TAP. The scorer uses the real tap.
'use strict'
const assert = require('node:assert')
const { isDeepStrictEqual, inspect } = require('node:util')

function loose (a, b) {
  try {
    assert.deepEqual(a, b)
    return true
  } catch {
    return false
  }
}

function subset (found, wanted) {
  if (wanted instanceof Error) return found instanceof Error && found.message === wanted.message
  if (wanted instanceof RegExp) return wanted.test(String(found))
  if (typeof wanted === 'string') return String(found).includes(wanted)
  if (typeof wanted === 'function') return found instanceof wanted || typeof found === wanted.name.toLowerCase()
  if (wanted && typeof wanted === 'object') {
    return found != null && Object.keys(wanted).every((k) => subset(found[k], wanted[k]))
  }
  return loose(found, wanted)
}

class Test {
  constructor (name, depth) {
    this.name = name
    this.depth = depth
    this.count = 0
    this.failed = 0
    this.planned = null
    this.ended = false
    this.queue = Promise.resolve()
    this.finished = new Promise((resolve) => { this.finish = resolve })
  }

  print (line) { console.log(' '.repeat(this.depth * 4) + line) }

  result (ok, name) {
    this.count++
    if (!ok) this.failed++
    this.print(`${ok ? 'ok' : 'not ok'} ${this.count} - ${name ?? ''}`.trimEnd())
    if (this.planned !== null && this.count >= this.planned) this.end()
    return ok
  }

  plan (n) {
    this.planned = n
    if (n === 0) this.end()
  }

  end () {
    if (this.ended) return
    this.ended = true
    this.queue.then(() => {
      this.print(`1..${this.count}`)
      this.finish()
    })
  }

  equal (found, wanted, msg) { return this.result(Object.is(found, wanted) || found === wanted, msg ?? 'should be equal') }
  not (found, wanted, msg) { return this.result(found !== wanted, msg ?? 'should not be equal') }
  ok (value, msg) { return this.result(!!value, msg ?? 'expect truthy value') }
  notOk (value, msg) { return this.result(!value, msg ?? 'expect falsey value') }
  same (found, wanted, msg) { return this.result(loose(found, wanted), msg ?? 'should be equivalent') }
  strictSame (found, wanted, msg) { return this.result(isDeepStrictEqual(found, wanted), msg ?? 'should be equivalent strictly') }
  match (found, wanted, msg) { return this.result(subset(found, wanted), msg ?? 'should match pattern') }
  notMatch (found, wanted, msg) { return this.result(!subset(found, wanted), msg ?? 'should not match pattern') }

  throws (fn, wanted, msg) {
    if (typeof wanted === 'string') [wanted, msg] = [undefined, wanted]
    if (typeof wanted !== 'object' && typeof wanted !== 'function') wanted = undefined
    try {
      fn()
    } catch (err) {
      return this.result(wanted === undefined || subset(err, wanted), msg ?? 'expected to throw')
    }
    return this.result(false, msg ?? 'expected to throw')
  }

  test (name, opts, fn) {
    if (typeof opts === 'function') fn = opts
    this.queue = this.queue.then(async () => {
      this.print(`# Subtest: ${name}`)
      const child = new Test(name, this.depth + 1)
      const returned = fn(child)
      if (returned && typeof returned.then === 'function') {
        await returned
        child.end()
      } else if (child.planned === null && !child.ended && fn.length === 0) {
        child.end()
      }
      await child.finished
      this.result(child.failed === 0, name)
    })
    return this.queue
  }
}

const root = new Test('root', 0)
// Tests do `const { test } = require('tap')`, so the root's methods must work unbound.
for (const name of Object.getOwnPropertyNames(Test.prototype)) {
  if (name !== 'constructor') root[name] = root[name].bind(root)
}
process.on('beforeExit', () => {
  if (root.ended) return
  root.end()
})
process.on('exit', () => {
  if (root.failed) process.exitCode = 1
})
module.exports = root
module.exports.Test = Test
module.exports.inspect = inspect

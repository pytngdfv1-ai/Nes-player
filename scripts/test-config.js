'use strict';
const assert = require('assert');
const { DEFAULTS, sanitize, applyPatch, findDuplicates } = require('../lib/config');

assert.deepStrictEqual(sanitize(null), JSON.parse(JSON.stringify(DEFAULTS)));
assert.strictEqual(sanitize({ keys: { a: 'KeyQ', b: '<script>' } }).keys.a, 'KeyQ');
assert.strictEqual(sanitize({ keys: { b: '<script>' } }).keys.b, 'KeyZ');
assert.strictEqual(sanitize({ view: { aspect: 'raro' } }).view.aspect, '4:3');
assert.strictEqual(sanitize({ slot: 9 }).slot, 1);
assert.strictEqual(sanitize({ recent: ['a', 'a', 5, 'b'] }).recent.length, 2);
assert.deepStrictEqual(findDuplicates(DEFAULTS), []);
const dup = applyPatch(DEFAULTS, { keys: { a: 'KeyZ' } });
assert.deepStrictEqual(findDuplicates(dup), ['KeyZ']);
assert.deepStrictEqual(applyPatch(DEFAULTS, { recent: ['x'], window: { width: 1 } }).recent, []);
console.log('config: OK');

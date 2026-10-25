const assert = require('assert');
const test = require('node:test');
const { normalizeUsername } = require('../src/username');

test('underscore and space are the same name (base37)', () => {
    assert.strictEqual(normalizeUsername('Kale_Stille      '), 'kale stille');
    assert.strictEqual(normalizeUsername('kale stille'), 'kale stille');
    assert.strictEqual(normalizeUsername('Kale_Stille'), normalizeUsername('KALE STILLE'));
});

test('multiple underscores all become spaces; plain names unchanged', () => {
    assert.strictEqual(normalizeUsername('a_b_c'), 'a b c');
    assert.strictEqual(normalizeUsername('Zasama'), 'zasama');
});

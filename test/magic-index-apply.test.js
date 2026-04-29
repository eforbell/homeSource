'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTagName, canonicalTagKey, findExistingTagId } = require('../lib/magic-index/apply');

describe('MagicIndex tag matching', () => {
  it('normalizes canonical keys for small format differences', () => {
    assert.equal(canonicalTagKey('  Product   Documentation '), 'product documentation');
    assert.equal(canonicalTagKey('Product-documentation'), 'product documentation');
  });

  it('binds to exact existing tag ignoring case', () => {
    const id = findExistingTagId([{ id: 2, name: 'Spec Sheet' }], 'spec sheet');
    assert.equal(id, 2);
  });

  it('binds fuzzy variants to existing family tags', () => {
    const tags = [{ id: 7, name: 'Hotel reservation confirmation' }];
    const id = findExistingTagId(tags, 'hotel reservation');
    assert.equal(id, 7);
  });

  it('returns null when no close match exists', () => {
    const id = findExistingTagId([{ id: 9, name: 'tax' }], 'golf swing analysis');
    assert.equal(id, null);
  });

  it('trims and bounds display tag names', () => {
    assert.equal(normalizeTagName('  alpha   beta  '), 'alpha beta');
  });
});

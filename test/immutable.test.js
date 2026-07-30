import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deepFreeze, frozenClone } from '../src/immutable.js';

describe('deepFreeze', () => {
  it('freezes mutable descendants even when a parent is already frozen', () => {
    const child = { nested: { value: 1 } };
    const parent = Object.freeze({ child });
    const result = deepFreeze(parent);
    assert.equal(result, parent);
    assert.equal(Object.isFrozen(parent), true);
    assert.equal(Object.isFrozen(child), true);
    assert.equal(Object.isFrozen(child.nested), true);
    assert.throws(() => { child.nested.value = 2; }, TypeError);
  });

  it('freezes a mutable grandchild beneath an already-frozen child', () => {
    const grandchild = { mutable: [1, 2, 3] };
    const child = Object.freeze({ grandchild });
    const root = deepFreeze({ child });
    assert.equal(Object.isFrozen(root), true);
    assert.equal(Object.isFrozen(grandchild), true);
    assert.equal(Object.isFrozen(grandchild.mutable), true);
    assert.throws(() => { grandchild.mutable.push(4); }, TypeError);
  });

  it('terminates self-cycles and freezes every reachable object exactly once', () => {
    const root = { name: 'root', child: { name: 'child' } };
    root.self = root;
    root.child.parent = root;
    root.child.sibling = root.child;
    deepFreeze(root);
    assert.equal(Object.isFrozen(root), true);
    assert.equal(Object.isFrozen(root.child), true);
    assert.equal(root.self, root);
    assert.equal(root.child.parent, root);
  });

  it('terminates multi-object cycles without unbounded recursion', () => {
    const a = { b: { c: {} } };
    a.b.c.a = a;
    const shared = { value: 1 };
    a.b.shared = shared;
    a.b.c.shared = shared;
    deepFreeze(a);
    assert.equal(Object.isFrozen(a.b.c), true);
    assert.equal(Object.isFrozen(shared), true);
  });

  it('preserves symbol-keyed descendants', () => {
    const key = Symbol('hidden');
    const root = { [key]: { deep: { value: 1 } } };
    deepFreeze(root);
    assert.equal(Object.isFrozen(root[key]), true);
    assert.equal(Object.isFrozen(root[key].deep), true);
  });

  it('frozenClone leaves the caller-owned source mutable', () => {
    const source = { nested: { value: 1 } };
    const clone = frozenClone(source);
    assert.notEqual(clone, source);
    assert.equal(Object.isFrozen(clone.nested), true);
    assert.equal(Object.isFrozen(source.nested), false);
    source.nested.value = 2;
    assert.equal(source.nested.value, 2);
  });
});

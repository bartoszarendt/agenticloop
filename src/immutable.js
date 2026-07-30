/**
 * Emitted artifacts are facts about a moment. A shallow `Object.freeze` still
 * lets a caller mutate a nested array or object and change what an in-memory
 * artifact appears to say after it was validated, so every emitted capture,
 * packet, return, receipt, and evidence object is frozen all the way down.
 */

/**
 * Recursively freeze a JSON-compatible value in place and return it.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value, visited = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  // Freeze before recursing so self-referential structures terminate. A
  // visited set tracks every object already handled: an already-frozen
  // intermediate object may still contain mutable descendants, so recursion
  // must continue through it regardless of its own frozen state.
  if (visited.has(value)) return value;
  visited.add(value);
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const nested = /** @type {any} */ (value)[key];
    if (nested !== null && typeof nested === 'object') deepFreeze(nested, visited);
  }
  return value;
}

/**
 * Deep-clone a JSON-compatible value, then deep-freeze the copy. Use this when
 * the source object is owned by a caller who may still mutate it.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function frozenClone(value) {
  if (value === null || typeof value !== 'object') return value;
  return deepFreeze(structuredClone(value));
}

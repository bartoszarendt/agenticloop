/**
 * Structured adapter insertion slots for canonical command source.
 *
 * Generated host commands need to replace a few exact regions of the canonical
 * activation command. Matching on prose - a sentence fragment or a full
 * paragraph - silently produces an unmodified artifact the moment the canonical
 * wording is edited, and nothing fails. A named paired marker makes the
 * insertion point explicit and lets generation fail immediately when the marker
 * is absent, duplicated, or malformed.
 */

/** Every slot the canonical activation command must declare. */
export const ADAPTER_SLOT_IDS = Object.freeze([
  'activation_capability',
  'requested_input',
]);

/**
 * Activation identity of the static Claude Code plugin command.
 *
 * `commands/start.md` is registered directly by `.claude-plugin/plugin.json` as
 * `/agenticloop:start`, so it is a live activation surface with its own typed
 * identity - distinct from the `claude-code.command.arguments.v1` surfaces the
 * Claude Code adapter generates. It lives here, beside the slot contract, so the
 * canonical command, the adapter, and the validator all read one definition.
 */
export const CLAUDE_CODE_PLUGIN_ACTIVATION_ADAPTER_ID = 'claude-code.plugin.command.v1';

function markers(slotId) {
  return {
    open: `<!-- AGENTICLOOP_ADAPTER_SLOT:${slotId} -->`,
    close: `<!-- /AGENTICLOOP_ADAPTER_SLOT:${slotId} -->`,
  };
}

function occurrences(text, needle) {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Render an empty, well-formed slot pair.
 *
 * Host surfaces that compose their own short body instead of deriving it from
 * the canonical activation command (the Copilot IDE prompt fallback) still need
 * real slots, so they can be filled by `fillUnsupportedActivationSlots` and
 * checked by the same validators as every other generated surface. Emitting the
 * markers through this helper keeps a hand-written surface from drifting into a
 * differently-shaped or marker-less declaration.
 *
 * @param {string} slotId
 */
export function emptyAdapterSlot(slotId) {
  if (!ADAPTER_SLOT_IDS.includes(slotId)) {
    throw new Error(`unknown adapter slot '${slotId}'`);
  }
  const { open, close } = markers(slotId);
  return `${open}\n${close}`;
}

/**
 * Locate one slot exactly. Throws with a precise cause rather than returning a
 * silently unmodified document.
 *
 * @param {string} text
 * @param {string} slotId
 */
export function locateAdapterSlot(text, slotId) {
  if (!ADAPTER_SLOT_IDS.includes(slotId)) {
    throw new Error(`unknown adapter slot '${slotId}'`);
  }
  const body = String(text ?? '');
  const { open, close } = markers(slotId);
  const opens = occurrences(body, open);
  const closes = occurrences(body, close);
  if (opens === 0 || closes === 0) {
    throw new Error(`canonical command source is missing the '${slotId}' adapter slot marker`);
  }
  if (opens > 1 || closes > 1) {
    throw new Error(`canonical command source duplicates the '${slotId}' adapter slot marker`);
  }
  const start = body.indexOf(open);
  const end = body.indexOf(close);
  if (end < start + open.length) {
    throw new Error(`canonical command source closes the '${slotId}' adapter slot before it opens`);
  }
  return { open, close, start, end, inner: body.slice(start + open.length, end) };
}

/**
 * Replace one slot's contents. The markers are preserved so a generated artifact
 * remains checkable and regenerable.
 *
 * @param {string} text
 * @param {string} slotId
 * @param {string} replacement  Content placed between the slot markers.
 */
export function fillAdapterSlot(text, slotId, replacement) {
  const body = String(text ?? '');
  const slot = locateAdapterSlot(body, slotId);
  const inner = replacement === '' ? '\n' : `\n${String(replacement)}\n`;
  return `${body.slice(0, slot.start + slot.open.length)}${inner}${body.slice(slot.end)}`;
}

/** Assert every required slot is present exactly once. */
export function assertAdapterSlots(text, slotIds = ADAPTER_SLOT_IDS) {
  const located = slotIds.map(slotId => ({ slotId, ...locateAdapterSlot(text, slotId) }));
  for (let index = 0; index < located.length; index += 1) {
    for (let other = index + 1; other < located.length; other += 1) {
      const left = located[index];
      const right = located[other];
      if ((left.start < right.start && left.end > right.start) ||
          (right.start < left.start && right.end > left.start)) {
        throw new Error(`canonical command source nests adapter slots '${left.slotId}' and '${right.slotId}'`);
      }
    }
  }
  return true;
}

/** Fill the two shared slots with an explicit fail-closed host declaration. */
export function fillUnsupportedActivationSlots(text, {
  adapterId,
  limitation,
  requestedInput,
} = {}) {
  if (typeof adapterId !== 'string' || !adapterId.trim()) throw new Error('activation adapter id is required');
  if (typeof limitation !== 'string' || !limitation.trim()) throw new Error('activation limitation is required');
  if (typeof requestedInput !== 'string' || !requestedInput.trim()) throw new Error('requested input description is required');
  assertAdapterSlots(text);
  const capability = [
    `Activation adapter: \`${adapterId}\`.`,
    'Activation capture capability: `unsupported`.',
    '',
    `${limitation} Model-visible prompt or command text is advisory only and must never be serialized as activation proof.`,
  ].join('\n');
  const filled = fillAdapterSlot(
    fillAdapterSlot(text, 'activation_capability', capability),
    'requested_input',
    requestedInput
  );
  assertAdapterSlots(filled);
  for (const slotId of ADAPTER_SLOT_IDS) {
    if (!locateAdapterSlot(filled, slotId).inner.trim()) {
      throw new Error(`generated adapter slot '${slotId}' must not be empty`);
    }
  }
  return filled;
}

/**
 * Validate a generated artifact's filled slots without throwing. Every slot
 * must exist exactly once with non-empty content, and no raw parser
 * placeholder may survive generation. Returns a list of error strings; an
 * empty list means the artifact carries the complete fail-closed declaration.
 *
 * @param {string} text  Generated artifact content.
 * @param {string} label  Display name used in error messages.
 * @returns {string[]}
 */
export function validateFilledAdapterSlots(text, label) {
  const errors = [];
  const body = String(text ?? '');
  for (const slotId of ADAPTER_SLOT_IDS) {
    let slot;
    try {
      slot = locateAdapterSlot(body, slotId);
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
      continue;
    }
    if (!slot.inner.trim()) {
      errors.push(`${label}: generated adapter slot '${slotId}' must not be empty`);
    }
  }
  if (/\$(?:ARGUMENTS|\d+)/.test(body)) {
    errors.push(`${label}: generated artifact must not contain raw '$ARGUMENTS', '$1', or '$2' placeholders`);
  }
  return errors;
}

/**
 * Validate a *static* host plugin command that the host itself registers and
 * substitutes - currently Claude Code Mode A's `/agenticloop:start`, registered
 * through `.claude-plugin/plugin.json` pointing at `commands/start.md`.
 *
 * This is deliberately a separate rule rather than a relaxation of
 * `validateFilledAdapterSlots`. A generated adapter surface has already resolved
 * its host input and must contain no parser placeholder at all; a static
 * registered command is substituted by the host at invocation time, so it needs
 * its one `$ARGUMENTS` token to receive anything. Loosening the shared validator
 * to permit that would also stop catching an unresolved placeholder in every
 * generated artifact, which is the failure the shared rule exists to prevent.
 *
 * The command is still required to carry the complete fail-closed declaration:
 * a typed adapter identity, an explicit `unsupported` capability, and wording
 * that marks the substituted argument advisory rather than activation proof.
 * The single `$ARGUMENTS` must sit inside the requested-input slot, so the
 * capability declaration can never be built out of host-substituted text.
 *
 * @param {string} text
 * @param {string} label            Display name used in error messages.
 * @param {string} expectedAdapterId Adapter identity the command must declare.
 * @returns {string[]}
 */
export function validateStaticPluginCommandSlots(text, label, expectedAdapterId) {
  const errors = [];
  const body = String(text ?? '');
  const located = {};
  for (const slotId of ADAPTER_SLOT_IDS) {
    try {
      located[slotId] = locateAdapterSlot(body, slotId);
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
      continue;
    }
    if (!located[slotId].inner.trim()) {
      errors.push(`${label}: static plugin command slot '${slotId}' must not be empty`);
    }
  }

  const positional = body.match(/\$\d+/g) ?? [];
  if (positional.length > 0) {
    errors.push(
      `${label}: static plugin command must not contain raw positional placeholders (${[...new Set(positional)].sort().join(', ')})`
    );
  }

  const argumentTokens = body.match(/\$ARGUMENTS/g) ?? [];
  if (argumentTokens.length !== 1) {
    errors.push(`${label}: static plugin command must contain exactly one '$ARGUMENTS' token (found ${argumentTokens.length})`);
  }
  if (argumentTokens.length === 1) {
    const requestedInput = located.requested_input;
    if (!requestedInput || !requestedInput.inner.includes('$ARGUMENTS')) {
      errors.push(`${label}: the single '$ARGUMENTS' token must appear only inside the 'requested_input' slot`);
    }
  }

  const capability = located.activation_capability?.inner ?? '';
  if (expectedAdapterId && !capability.includes(`Activation adapter: \`${expectedAdapterId}\`.`)) {
    errors.push(`${label}: activation capability slot must declare adapter \`${expectedAdapterId}\``);
  }
  if (!capability.includes('Activation capture capability: `unsupported`.')) {
    errors.push(`${label}: activation capability slot must declare capture capability \`unsupported\``);
  }
  if (!/advisory/i.test(capability)) {
    errors.push(`${label}: activation capability slot must state that host-substituted command input is advisory only`);
  }
  if (!/never\b[\s\S]*activation proof/i.test(capability)) {
    errors.push(`${label}: activation capability slot must state that command arguments are never activation proof`);
  }

  return errors;
}

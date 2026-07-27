/**
 * AST-based diagnostic-architecture enforcement, built on the TypeScript
 * compiler API. Evaluators report diagnostic facts only; role routing exists
 * solely in approved presentation modules. This checker rejects:
 *
 * 1. Diagnostic-shaped object literals with routing fields (owner,
 *    escalationOwner, ownerRouting, nextAction, firstSafeRepair) outside
 *    approved presentation modules.
 * 2. createDiagnostic calls that supply protected fields.
 * 3. Role-name prose concatenated into diagnostic messages.
 * 4. Diagnostic construction that bypasses the canonical fact constructor.
 *
 * Legitimate non-diagnostic ownership fields (event roles, attribution
 * contracts, adapter generation) are unaffected: a literal is only
 * diagnostic-shaped when it also carries message/category/code/level shape.
 */

import { createRequire } from 'node:module';

// The classic TypeScript compiler API (installed as the `ts5` alias; the
// native `typescript` v7 package no longer exposes createSourceFile).
const ts = createRequire(import.meta.url)('ts5');

export const APPROVED_PRESENTATION_MODULES = new Set([
  'src/diagnostic-presentation.js',
  // Closeout reason packets are durable workflow contracts, not evaluator
  // diagnostics.
  'src/closeout.js',
]);

/** The canonical fact constructor module itself may build fact literals. */
export const CONSTRUCTOR_MODULES = new Set(['src/repair-policy.js']);

const ROUTING_FIELDS = new Set(['owner', 'escalationOwner', 'ownerRouting', 'nextAction', 'firstSafeRepair']);
const PROTECTED_CONSTRUCTOR_FIELDS = new Set(['category', 'repairKind', 'escalationKind', ...ROUTING_FIELDS]);
const DIAGNOSTIC_SHAPE_FIELDS = new Set(['message', 'category', 'code', 'level']);
const ROLE_WORDS_RE = /\b(?:orchestrator|maintainer|engineer|auditor)\b/i;

function propertyName(node) {
  if (!node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return null;
}

function isCreateDiagnosticCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const expression = node.expression;
  return (ts.isIdentifier(expression) && expression.text === 'createDiagnostic') ||
    (ts.isPropertyAccessExpression(expression) && expression.name.text === 'createDiagnostic');
}

/** String content of a message-ish expression, if it is composed from parts. */
function composedStringHasRoleProse(node) {
  if (!node) return false;
  if (ts.isTemplateExpression(node)) {
    return ROLE_WORDS_RE.test(node.head.text) || node.templateSpans.some(span => ROLE_WORDS_RE.test(span.literal.text));
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const textOf = side => (ts.isStringLiteral(side) || ts.isNoSubstitutionTemplateLiteral(side) ? side.text : '');
    return ROLE_WORDS_RE.test(textOf(node.left)) || ROLE_WORDS_RE.test(textOf(node.right)) ||
      composedStringHasRoleProse(node.left) || composedStringHasRoleProse(node.right);
  }
  return false;
}

/**
 * Inspect one source file and return a list of violations:
 * `{ rule, line, detail }`.
 */
export function checkDiagnosticArchitecture(sourceText, { fileName = 'fixture.js', presentation = false, constructorModule = false } = {}) {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const violations = [];
  const lineOf = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const literalFields = node => new Set(node.properties.map(propertyName).filter(Boolean));

  const visit = node => {
    if (ts.isObjectLiteralExpression(node)) {
      const fields = literalFields(node);
      const routing = [...fields].filter(field => ROUTING_FIELDS.has(field));
      const shape = [...fields].filter(field => DIAGNOSTIC_SHAPE_FIELDS.has(field));
      if (!presentation && routing.length > 0 && shape.length > 0) {
        violations.push({
          rule: 'routing-fields-in-diagnostic',
          line: lineOf(node),
          detail: `diagnostic-shaped literal carries routing field(s): ${routing.join(', ')}`,
        });
      }
      if (!presentation && !constructorModule && routing.length === 0 && fields.has('code') && fields.has('message') &&
        (fields.has('level') || fields.has('category') || fields.has('repairKind'))) {
        const parent = node.parent;
        const isConstructorArg = ts.isCallExpression(parent) && isCreateDiagnosticCall(parent) && parent.arguments[0] === node;
        if (!isConstructorArg) {
          violations.push({
            rule: 'non-canonical-diagnostic-construction',
            line: lineOf(node),
            detail: 'diagnostic fact literal bypasses createDiagnostic',
          });
        }
      }
      if (!presentation) {
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const name = propertyName(property);
          if ((name === 'message' || name === 'warning') && composedStringHasRoleProse(property.initializer) &&
            (fields.has('code') || fields.has('category') || fields.has('level'))) {
            violations.push({
              rule: 'role-prose-in-diagnostic-message',
              line: lineOf(property),
              detail: `role-name prose concatenated into diagnostic '${name}'`,
            });
          }
        }
      }
    }
    if (!presentation && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      /message|warning|diagnostic/i.test(node.name.text) && composedStringHasRoleProse(node.initializer)) {
      violations.push({
        rule: 'role-prose-in-diagnostic-message',
        line: lineOf(node),
        detail: `role-name prose concatenated into '${node.name.text}'`,
      });
    }
    if (isCreateDiagnosticCall(node)) {
      const [argument] = node.arguments;
      if (argument && ts.isObjectLiteralExpression(argument)) {
        for (const property of argument.properties) {
          const name = propertyName(property);
          if (name && PROTECTED_CONSTRUCTOR_FIELDS.has(name)) {
            violations.push({
              rule: 'protected-field-to-constructor',
              line: lineOf(property),
              detail: `createDiagnostic argument supplies protected field '${name}'`,
            });
          }
          if (name === 'message' && ts.isPropertyAssignment(property) && composedStringHasRoleProse(property.initializer)) {
            violations.push({
              rule: 'role-prose-in-diagnostic-message',
              line: lineOf(property),
              detail: 'role-name prose concatenated into a createDiagnostic message',
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

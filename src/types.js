/**
 * Shared JSDoc typedefs for Agentic Loop modules.
 * This file contains only type definitions; no runtime code.
 */

/**
 * @typedef {{ errors: string[], warnings: string[] }} ValidationMessages
 */

/**
 * @typedef {object} ValidationReport
 * @property {number} totalErrors
 * @property {number} totalWarnings
 * @property {object} skillReport
 * @property {string[]} activationErrors
 * @property {string[]} activationWarnings
 * @property {string[]} configErrors
 * @property {string[]} configWarnings
 * @property {string[]} eventLogErrors
 * @property {string[]} eventLogWarnings
 */

/**
 * @typedef {object} AgenticLoopConfig
 * @property {string} [extends]
 * @property {{ sourceDirectory?: string }} [agents]
 * @property {{ sourceDirectory?: string }} [backends]
 * @property {{ sourceDirectory?: string }} [skills]
 * @property {Record<string, RoleConfig>} [roles]
 * @property {Record<string, object>} [adapters]
 * @property {Record<string, string>} [documents]
 */

/**
 * @typedef {object} RoleConfig
 * @property {string} [description]
 * @property {string} [sourceFile]
 * @property {string} [model]
 * @property {string} [reasoningEffort]
 * @property {string} [variant]
 * @property {string[]} [requiredSkills]
 */

/**
 * @typedef {'github' | 'files'} TaskBackendName
 */

/**
 * @typedef {object} TaskBackendResolution
 * @property {string} backend
 * @property {string} source
 * @property {string | null} legacyJsonTaskBackend
 * @property {string | null} projectTaskBackend
 * @property {string[]} warnings
 * @property {string | null} projectMapPath
 * @property {string | null} jsonConfigPath
 * @property {object | null} projectMapResult
 * @property {object | null} rawJsonConfig
 * @property {Error | null} rawJsonConfigError
 */

/**
 * @typedef {object} RoleSourceResult
 * @property {string} description
 * @property {string} body
 * @property {boolean} exists
 */

/**
 * @typedef {object} RoleRecord
 * @property {string} description
 * @property {string} sourceFile
 * @property {string} promptBody
 * @property {string[]} requiredSkills
 */

/**
 * @typedef {object} CanonicalSkillEntry
 * @property {string} canonicalName
 * @property {string} sourceDir
 * @property {string} skillFile
 */

/**
 * @typedef {object} ResolvedRoleModel
 * @property {string} model
 * @property {string} variant
 * @property {string} source
 */

export {};

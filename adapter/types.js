/**
 * @typedef {Object} NormalizedUser
 * @property {string} id
 * @property {'admin'|'maintainer'|'member'} role
 * @property {string[]} [projectIds]
 */

/**
 * @typedef {Object} NormalizedMessage
 * @property {'zulip'|'hermes'|'harness'} platform
 * @property {string} text
 * @property {NormalizedUser} user
 * @property {string} [stream]
 * @property {string} [topic]
 * @property {string} [conversationId]
 * @property {string} [messageId]
 * @property {string} receivedAt
 */

/**
 * @typedef {Object} AdapterState
 * @property {{ [targetKey: string]: string }} bindings
 * @property {{ [taskId: string]: object }} tasks
 * @property {{ [projectId: string]: object }} activeWriters
 * @property {string} updatedAt
 */

export {};

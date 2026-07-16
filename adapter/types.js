/**
 * @typedef {Object} NormalizedUser
 * @property {string} id
 * @property {'admin'|'maintainer'|'member'} role
 * @property {string[]} [projectIds]
 */

/**
 * @typedef {Object} NormalizedMessage
 * @property {'zulip'|'feishu'|'hermes'|'harness'} platform
 * @property {string} text
 * @property {NormalizedUser} user
 * @property {string} [stream] Zulip stream. For Zulip, this maps to project routing.
 * @property {string} [topic] Zulip topic. For Zulip, this maps to the conversation/notification target.
 * @property {string} [conversationId] Generic conversation id for Feishu, Hermes, and harness messages.
 * @property {string} [messageId]
 * @property {string} receivedAt
 */

/**
 * @typedef {Object} AdapterState
 * @property {{ [targetKey: string]: string }} bindings
 * @property {{ [stream: string]: string }} zulipStreamProjectRoutes
 * @property {{ [stream: string]: boolean }} zulipGenericStreams
 * @property {{ [targetKey: string]: object }} zulipTopicModes
 * @property {{ [taskId: string]: object }} tasks
 * @property {{ [projectId: string]: object }} activeWriters
 * @property {string} updatedAt
 */

export {};

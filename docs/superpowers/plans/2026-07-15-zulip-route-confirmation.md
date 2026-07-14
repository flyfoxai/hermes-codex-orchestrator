# Zulip Route Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent Zulip stream-to-project routing with explicit human confirmation and a no-project generic-channel state.

**Architecture:** Extend the adapter command parser with `/codex route ...` commands. Store runtime Zulip route decisions in adapter state, resolve Zulip streams from runtime state before static config, and block project task creation when a new stream needs human confirmation or has been marked generic.

**Tech Stack:** Node.js ESM, built-in `node:assert/strict` tests, existing adapter harness scripts.

## Global Constraints

- Zulip stream/channel maps to project only after explicit mapping, exact config match, or safe exact projectId match.
- Zulip topic remains conversation/notification target and never participates in project routing.
- Similar project suggestions are advisory only; write/read task creation must wait for `/codex route confirm <projectId>` or `/codex route set <projectId>`.
- `/codex route none` marks the current Zulip stream as generic/no-project and suppresses future association prompts for that stream.
- Feishu, Hermes-native, and harness routing must continue to use explicit projectId, conversation binding, then optional defaultProjectId.

## Task 1: Commands and State

**Files:**
- Modify: `adapter/commands.js`
- Modify: `adapter/state-store.js`
- Test: `scripts/adapter-foundation-test.js`

**Deliverable:** Parser and state support for `route show`, `route set`, `route confirm`, `route unset`, and `route none`.

## Task 2: Zulip Routing Resolution

**Files:**
- Modify: `adapter/router.js`
- Test: `scripts/adapter-foundation-test.js`

**Deliverable:** Runtime route state overrides static config; generic streams raise `route_generic`; unresolved streams raise `route_confirmation_required` with suggested project IDs.

## Task 3: Handler Behavior

**Files:**
- Modify: `adapter/handler.js`
- Test: `scripts/adapter-handler-test.js`

**Deliverable:** Unknown Zulip streams ask for association before task creation; route commands persist choices; generic streams do not create Runner tasks.

## Task 4: Documentation and Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/HERMES_ZULIP_ADAPTER_INTEGRATION.md`
- Modify: `/Users/hula/.hermes/skills/software-development/hermes-codex-orchestrator/SKILL.md`
- Modify: `/Users/hula/.hermes/profiles/ask-jarvis-pm/skills/software-development/hermes-codex-orchestrator/SKILL.md`

**Deliverable:** User-facing docs describe route management commands, confirmation flow, and generic-channel behavior. Verify with `npm run adapter:verify` and `npm run verify`.

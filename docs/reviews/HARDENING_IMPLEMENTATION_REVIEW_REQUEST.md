# Hardening Implementation Review Request

## Objective

Review the current repository implementation against `docs/IMPROVEMENT_WORK_PLAN.md`. This is a pre-deployment code and documentation review, not an authorization to deploy or change code.

## Architectural context

`docs/IMPROVEMENT_WORK_PLAN.md` is the accepted specification and decision record for this change. The repository has no Git metadata and no separate ADR directory. Review compliance with that plan, especially its single-Runner boundary, task Markdown source of truth, loopback/Tailscale boundary, fail-closed authentication, atomic task updates, and graceful shutdown contract.

## Files in scope

- `runner/config.js`
- `runner/http.js`
- `runner/task-store.js`
- `runner/tmux.js`
- `runner/index.js`
- `scripts/hardening-test.js`
- `package.json`
- `docs/SETUP.md`
- `docs/OPERATIONS.md`
- `docs/DEVMAC_CODEX_HANDOFF.md`

Read other repository files where needed to verify call paths and compatibility.

## Known verification state

`npm run verify` passed locally on Node.js v24.13.0 after the current changes. The suite includes syntax, smoke, API contract, dispatch failure, fake-Codex dispatch success, and hardening tests. Passing tests are evidence, not proof that the implementation is correct.

Real Codex task execution, user-level LaunchAgent installation, Tailscale Serve, public exposure checks, and Windows execution have not been performed in this development pass.

## Review requirements

1. Find concrete correctness, security, concurrency, shutdown, API contract, test reliability, and operations-documentation issues.
2. Check every mandatory item in sections 4, 5, 7, and 8 of the plan.
3. Prioritize Critical and High findings. Do not report speculative style preferences.
4. For each finding include severity, exact file and line, observed behavior, why it violates the plan or creates a real failure, a specific remediation, and the regression test needed.
5. Distinguish code blockers from external deployment checks that simply remain unexecuted.
6. If no Critical or High issue exists, say so explicitly and list residual Medium/Low risks and external verification gaps.
7. Do not edit application code, tests, configuration, or other documentation.

## Output contract

Write one self-contained Markdown review to the output path named in your prompt. Modify no other file. End with one verdict:

- `BLOCKED`
- `READY_FOR_EXTERNAL_DEPLOYMENT_VALIDATION`

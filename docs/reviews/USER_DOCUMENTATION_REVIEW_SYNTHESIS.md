# User documentation review synthesis

## Inputs

- `docs/reviews/USER_DOCUMENTATION_DRAFT_REQUEST.md`
- `docs/reviews/CLAUDE_USER_DOCUMENTATION_DRAFT.md`
- `docs/reviews/GEMINI_USER_DOCUMENTATION_DRAFT.md`
- `README.md`
- `docs/SETUP.md`
- `docs/OPERATIONS.md`
- `HTTP_API_INTEGRATION.md`

## Claude draft review

Claude's draft covered the full operational surface: prerequisites, Token workflow, startup, project registration, task creation, query APIs, generated files, deployment boundaries, FAQ, and deployment checklist. It also captured the fail-closed authentication rule and the loopback-only `HCO_AUTH_MODE=none` constraint.

Issues corrected in the final README:

- The original Claude CLI output had formatting glitches such as missing spaces around headings and arrows.
- Links were saved under `docs/reviews/`, so relative links in the archived candidate point upward; the final README uses root-relative repository paths.
- The draft repeated some deployment checklist material that belongs in `docs/OPERATIONS.md`; the final README keeps the checklist as a boundary summary and links to the operations guide.

## Gemini draft review

Gemini's draft had a clean reader flow and concise API examples. It was useful as the structural baseline for the final README.

Issues corrected in the final README:

- The draft under-specified several security boundaries, including one Runner per config root, `/health` requiring auth, and Tailscale/LAN requiring Token mode.
- It described the Runner as only listening on loopback in operational boundaries. The final README clarifies that loopback is recommended and private forwarding is allowed after separate validation.
- It linked to an external Codex CLI project URL that is not part of this repository's verified documentation set, so the final README does not include that link.

## Final README decisions

- Keep the README as a first-run how-to and orientation document.
- Avoid claiming deployment is complete. The README states that local verification is complete but external deployment validation remains separate.
- Use repository-external `~/.hco/token` examples and `$HCO_API_TOKEN` expansion only.
- Keep LaunchAgent/systemd details in `docs/OPERATIONS.md`.
- Link both AI-generated candidate drafts as audit artifacts.

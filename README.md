# TriagePilot

A Forge app for **Codegeist 2026** (Atlassian) — category **Apps for
Software Teams**, bonus **Best Agents** (Rovo).

TriagePilot triages incoming Jira issues with real context: it reads the
issue and its linked Confluence pages, searches for similar issues that
might be duplicates, and proposes a priority, a suggested owner area, a
duplicate warning and a missing-information checklist. A human approves
the proposal in the Jira issue panel (or dismisses it) — the app never
changes Jira by itself.

## Design constraints (locked)

- **No Forge LLM API calls** — Codegeist provides no credits and the
  calls are charged. The AI angle is the Rovo agent prompt plus the
  deterministic triage engine in `src/triage.js`.
- **Human-approval gate** — the only write path is `applyApproval` in
  `src/index.js`, which refuses to run unless `approved === true` and
  only sets the approved priority, adds one audit label and posts one
  comment.
- **Explainable** — every proposal carries its reasons in plain language.

## Structure

- `manifest.yml` — rovo:agent, three Rovo actions, `jira:issuePanel`, functions, scopes.
- `prompts/prompt.md` — the Rovo agent prompt (also referenced from the manifest).
- `src/triage.js` — pure deterministic triage engine, zero Forge dependencies.
- `src/index.js` — Forge functions: Rovo actions + panel resolver.
- `src/frontend/index.jsx` — UI Kit 2 issue panel (Approve / Dismiss).
- `test/triage.test.js` — unit tests for the engine (`npm test`).
- `BUILD.md` — build log: versions, test results, blockers.

## Deploy (needs Firman's Atlassian account — see BUILD.md)

```bash
npm install -g @forge/cli   # 16.0.0, needs Node >= 22.23.4
forge login                 # Atlassian API token
forge register              # replaces the placeholder app.id in manifest.yml
forge deploy
forge install --demo-site   # demo site ships Rovo; free dev sites often lack Rovo Chat
```

## Local validation (no login needed)

```bash
npm install
npm test                    # unit tests for src/triage.js
node --check src/triage.js && node --check src/index.js
```

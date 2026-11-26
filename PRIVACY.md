# Privacy Policy — TriagePilot

Effective date: 26 November 2026

TriagePilot is a Forge app for Jira, built by Firman Yuansyach for the Codegeist 2026 hackathon.

## What the app does

TriagePilot reads Jira issue data (summary, description, status, priority, assignee, labels, components) and the content of Confluence pages linked to an issue, and proposes a triage: a priority, a suggested owner area, possible duplicates, and a missing-information checklist. A Rovo agent offers the same proposal in chat.

## What data is collected or stored

TriagePilot does not collect, store, or transmit personal data to any server outside your Atlassian site. The app:

- makes no external network calls and uses no third-party services;
- uses no analytics, tracking, cookies, or advertising;
- calls no Forge LLM APIs;
- stores nothing in its own database — there is no app-side storage at all.

Issue and page data is processed in memory, only inside your Atlassian site, only to produce the proposal you see.

## What the app writes

Nothing is written to Jira except when a human presses Approve in the TriagePilot panel. Approve sets the proposed priority, adds the `triagepilot-reviewed` label, and posts one audit comment. Dismiss writes nothing. The Rovo agent never writes anything.

## Contact

Questions about this policy: firmanyuansyach123@gmail.com

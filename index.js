// TriagePilot — Forge backend (functions + resolver).
// Read-only everywhere EXCEPT applyApproval, which only runs when the
// human explicitly approves in the issue panel (approved === true).
// No Forge LLM API calls anywhere in this file.

import api, { route } from '@forge/api';
import { makeResolver } from '@forge/resolver';
import {
  PRIORITY_LEVELS,
  normalizeIssue,
  proposeTriage as buildProposal,
  buildDuplicateJql,
} from './triage.js';

const MAX_SIMILAR_RESULTS = 5;
const MAX_LINKED_PAGES = 3;

function issueKeyOf(payload = {}) {
  const key = payload.issueKey || payload.issue?.key || payload.key || '';
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('issueKey is required (e.g. "PROJ-123").');
  }
  return key.trim().toUpperCase();
}

async function requestJiraJson(routeObj, label, options = {}) {
  const res = await api.asApp().requestJira(routeObj, options);
  if (!res.ok) {
    throw new Error(`Jira API ${res.status} for ${label}`);
  }
  return res.json();
}

/** Fetch one issue and normalise it for the triage engine. */
async function fetchIssue(issueKey) {
  const data = await requestJiraJson(
    route`/rest/api/3/issue/${issueKey}?fields=summary,description,status,priority,assignee,labels,components,issuetype,project`,
    `issue ${issueKey}`,
  );
  const issue = normalizeIssue(data);
  return { ...issue, descriptionAdf: data.fields?.description ?? null };
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // Drop standalone hex colour codes (e.g. #F4F5F7) that leak from
    // Confluence macro parameters in storage format — invisible on the page.
    .replace(/(^|\s)#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Linked Confluence pages for an issue, read-only. Remote links on the
 * issue already carry url + title; for Confluence page links we also
 * fetch the first 500 characters of the page body for triage context.
 * Any single failure degrades to title + url only — never fails the
 * whole proposal.
 */
async function fetchLinkedConfluencePages(issueKey) {
  let links = [];
  try {
    links = await requestJiraJson(route`/rest/api/3/issue/${issueKey}/remotelink`, `remotelinks ${issueKey}`);
  } catch (error) {
    console.log(`TriagePilot: remotelink fetch failed for ${issueKey}: ${error.message}`);
    return [];
  }
  const pages = [];
  for (const link of Array.isArray(links) ? links : []) {
    const url = link?.object?.url || '';
    const title = link?.object?.title || url;
    if (!url || !/atlassian\.net\/wiki\//i.test(url)) continue;
    const page = { url, title, excerpt: '' };
    // Confluence page ids appear as /pages/<id>/... or as
    // viewpage.action?pageId=<id> (the classic "copy link" form).
    const match = url.match(/\/pages\/(\d+)(?:\/|$)/) || url.match(/[?&]pageId=(\d+)/);
    if (match) {
      // Confluence v2 API with the granular read:page:confluence scope is the
      // documented path. The v1 content endpoint kept returning 401 "scope
      // does not match" on this install even with read:confluence-content.all
      // granted, so v2 is tried first and v1 stays only as a fallback.
      const attempts = [
        route`/wiki/api/v2/pages/${match[1]}?body-format=storage`,
        route`/wiki/rest/api/content/${match[1]}?expand=body.storage`,
      ];
      for (const path of attempts) {
        try {
          const res = await api.asApp().requestConfluence(path);
          console.log(`TriagePilot: Confluence page ${match[1]} fetch status ${res.status}`);
          if (res.ok) {
            const content = await res.json();
            page.excerpt = stripHtml(content?.body?.storage?.value || '').slice(0, 500);
            break;
          }
          console.log(
            `TriagePilot: Confluence page ${match[1]} error body: ${(await res.text()).slice(0, 200)}`,
          );
        } catch (error) {
          console.log(`TriagePilot: Confluence page ${match[1]} unreadable: ${error.message}`);
        }
      }
    }
    pages.push(page);
    if (pages.length >= MAX_LINKED_PAGES) break;
  }
  return pages;
}

/** JQL search for issues with a similar summary (read-only). */
async function searchSimilarIssues(issue) {
  const { jql, terms } = buildDuplicateJql(issue.summary, issue.projectKey);
  if (!jql) return { jql: null, terms, candidates: [] };
  try {
    // POST /rest/api/3/search/jql is the current Jira Cloud search
    // endpoint (GET /rest/api/3/search was deprecated). Confirm at
    // deploy time if Jira answers 404/410 here.
    const res = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jql,
        fields: ['summary', 'status', 'priority'],
        maxResults: MAX_SIMILAR_RESULTS,
      }),
    });
    if (!res.ok) {
      console.log(`TriagePilot: JQL search failed (${res.status}), continuing without duplicates.`);
      return { jql, terms, candidates: [] };
    }
    const data = await res.json();
    const candidates = (data.issues || []).map((entry) => ({
      key: entry.key,
      summary: entry.fields?.summary || '',
      status: entry.fields?.status?.name || '',
    }));
    return { jql, terms, candidates };
  } catch (error) {
    console.log(`TriagePilot: JQL search error: ${error.message}`);
    return { jql, terms, candidates: [] };
  }
}

async function proposeTriageForIssue(issueKey) {
  const issue = await fetchIssue(issueKey);
  const { candidates } = await searchSimilarIssues(issue);
  const proposal = buildProposal(issue, candidates);
  const linkedPages = await fetchLinkedConfluencePages(issueKey);
  return { ...proposal, linkedPages };
}

// ---------------------------------------------------------------------------
// Rovo agent actions (each maps to an `action` module in manifest.yml).
// They only read. Rovo invokes them with the action inputs as payload.
// ---------------------------------------------------------------------------

export async function getIssueContext(payload) {
  const issueKey = issueKeyOf(payload);
  const issue = await fetchIssue(issueKey);
  const linkedPages = await fetchLinkedConfluencePages(issueKey);
  return { issue, linkedPages };
}

export async function findSimilarIssues(payload) {
  const issueKey = issueKeyOf(payload);
  const issue = await fetchIssue(issueKey);
  return searchSimilarIssues(issue);
}

export async function proposeTriage(payload) {
  const issueKey = issueKeyOf(payload);
  return proposeTriageForIssue(issueKey);
}

// ---------------------------------------------------------------------------
// Issue-panel resolver. getProposal reuses the same code as the Rovo
// action, so the panel and the agent share the same deterministic
// proposal; the agent may add context in prose around it, so their
// wording can differ while the underlying proposal data is identical.
// NOTE: @forge/resolver 2.x is used via the NAMED export makeResolver.
// The default import (`import Resolver from '@forge/resolver'` + `new
// Resolver()`) crashes at module load in the Forge webpack bundle
// ("resolver_out_namespaceObject is not a constructor") — the bundler
// resolves the default import to the module namespace object, which is
// not a constructor. That single load failure broke every function in
// this module: the panel resolver AND all three Rovo actions (500).
// ---------------------------------------------------------------------------

export const handler = makeResolver({
  getProposal: async ({ payload }) => {
    const issueKey = issueKeyOf(payload);
    return proposeTriageForIssue(issueKey);
  },

  // THE ONLY WRITE PATH IN THIS APP. It refuses to run unless the human
  // pressed Approve in the panel (approved === true). The priority it
  // writes is RECOMPUTED server-side from the current issue — the
  // frontend-supplied priority value is never trusted. It sets only
  // that priority, adds one audit label, and posts one comment naming
  // the proposal. Nothing else is written, ever.
  applyApproval: async ({ payload }) => {
    if (payload?.approved !== true) {
      throw new Error('applyApproval requires explicit human approval (approved: true).');
    }
    const issueKey = issueKeyOf(payload);

    // Recompute the proposal from the live issue: the priority applied
    // is the engine's current answer, not whatever the panel sent.
    const proposal = await proposeTriageForIssue(issueKey);
    const proposedPriority = proposal.priority;
    let priorityToSet = '';
    if (PRIORITY_LEVELS.includes(proposedPriority)) {
      priorityToSet = proposedPriority;
    } else if (proposedPriority === proposal.currentPriority) {
      // Non-standard priority already set in Jira (e.g. a site-specific
      // "Critical"): keep it — there is nothing to write for priority,
      // and writing it would fail validation below.
      priorityToSet = '';
    } else {
      throw new Error(`Unknown priority: ${proposedPriority}`);
    }

    const body = { fields: {}, update: { labels: [{ add: 'triagepilot-reviewed' }] } };
    if (priorityToSet) body.fields.priority = { name: priorityToSet };
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Applying approval failed: Jira API ${res.status}`);
    }

    // The priority change above is the essential write; the audit
    // comment is a nicety. If posting it fails, log it and still report
    // success — a thrown error here would make the panel say "Apply
    // failed" and invite a retry that posts a duplicate comment.
    let commentPosted = false;
    try {
      const commentLines = [
        `TriagePilot proposal approved by a human.`,
        priorityToSet ? `Priority set to ${priorityToSet}.` : 'Priority left unchanged.',
        'Labels: triagepilot-reviewed.',
      ];
      const commentRes = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: commentLines.join(' ') }],
              },
            ],
          },
        }),
      });
      if (!commentRes.ok) {
        throw new Error(`Jira API ${commentRes.status} posting the audit comment`);
      }
      commentPosted = true;
    } catch (commentError) {
      console.log(
        `TriagePilot: audit comment failed for ${issueKey} after priority was applied: ${commentError.message}`,
      );
    }
    return { applied: true, issueKey, priority: priorityToSet || null, commentPosted };
  },

  // Dismiss writes nothing. It exists so the panel can record the human's
  // decision in the UI without touching Jira.
  dismissProposal: async ({ payload }) => {
    const issueKey = issueKeyOf(payload);
    return { dismissed: true, issueKey };
  },
});

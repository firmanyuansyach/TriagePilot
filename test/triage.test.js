// Unit tests for the pure triage engine (src/triage.js).
// Run: npm test   (node --test, no dependencies)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  adfToText,
  buildDuplicateJql,
  detectDuplicates,
  extractSearchTerms,
  findRelatedIssues,
  missingInfoChecklist,
  proposeTriage,
  scorePriority,
  suggestArea,
  suggestAreaWithSource,
} from '../src/triage.js';

const completeIssue = {
  key: 'PROJ-101',
  fields: {
    summary: 'Add export button to the report page',
    description: 'As a manager I want to export the monthly report as CSV. Expected: a CSV download starts. Actual: no button exists yet.',
    status: { name: 'To Do' },
    priority: { name: 'Medium' },
    assignee: { displayName: 'Ana' },
    labels: ['reporting'],
    components: [{ name: 'Frontend' }],
    issuetype: { name: 'Story' },
    project: { key: 'PROJ' },
  },
};

describe('scorePriority', () => {
  it('crash / blocker keywords score Highest', () => {
    const { priority, score } = scorePriority({
      fields: {
        summary: 'App crashes on login — users blocked',
        description: 'The app crashes every time a user logs in. This is a blocker for the release.',
        issuetype: { name: 'Bug' },
      },
    });
    assert.equal(priority, 'Highest');
    assert.ok(score >= 45, `expected score >= 45, got ${score}`);
  });

  it('data-loss keyword scores Highest', () => {
    const { priority } = scorePriority({
      fields: {
        summary: 'Data loss when saving a draft',
        description: 'Draft content disappears after save.',
        issuetype: { name: 'Bug' },
      },
    });
    assert.equal(priority, 'Highest');
  });

  it('docs / typo only scores Low or Lowest', () => {
    const { priority, score } = scorePriority({
      fields: {
        summary: 'Typo in the onboarding docs',
        description: 'The word “seperate” should be “separate” in the getting-started guide.',
        issuetype: { name: 'Task' },
      },
    });
    assert.ok(['Low', 'Lowest'].includes(priority), `got ${priority}`);
    assert.ok(score < 15, `expected score < 15, got ${score}`);
  });

  it('an explicitly set Jira priority is kept as a floor', () => {
    const { priority } = scorePriority({
      fields: {
        summary: 'Minor label alignment issue',
        description: 'A label is 2px off on the settings page.',
        priority: { name: 'High' },
        issuetype: { name: 'Task' },
      },
    });
    assert.equal(priority, 'High');
  });

  it('a non-standard priority already set in Jira is kept as the proposal', () => {
    const { priority, reasons } = scorePriority({
      fields: {
        summary: 'Minor label alignment issue',
        description: 'A label is 2px off on the settings page.',
        priority: { name: 'Critical' },
        issuetype: { name: 'Task' },
      },
    });
    assert.equal(priority, 'Critical');
    assert.ok(
      reasons.some((r) => r.includes('non-standard') && r.includes('Critical')),
      `expected a non-standard-priority reason, got: ${reasons.join(' | ')}`,
    );
  });

  it('non-English input does not crash and still finds loanword signals', () => {
    const { priority } = scorePriority({
      fields: {
        summary: 'Aplikasi crash saat login',
        description: 'Pengguna tidak bisa masuk, aplikasi langsung crash.',
        issuetype: { name: 'Bug' },
      },
    });
    assert.equal(priority, 'Highest');
  });

  it('empty issue does not crash and scores Lowest', () => {
    const result = scorePriority({});
    assert.equal(result.priority, 'Lowest');
    assert.equal(result.score, 0);
    assert.ok(result.reasons.length > 0);
  });
});

describe('duplicates', () => {
  it('buildDuplicateJql extracts distinctive terms and a usable JQL', () => {
    const { jql, terms } = buildDuplicateJql('Login page crashes on Safari after update', 'PROJ');
    assert.ok(terms.includes('login') || terms.includes('crashes') || terms.includes('safari'));
    assert.ok(jql.includes('project = "PROJ"'));
    assert.ok(jql.includes('text ~'));
  });

  it('a near-identical summary is flagged as a duplicate', () => {
    const warnings = detectDuplicates(
      { key: 'PROJ-1', fields: { summary: 'Login page crashes on Safari after update' } },
      [
        { key: 'PROJ-9', summary: 'Login page crashes on Safari after the latest update', status: 'Open' },
        { key: 'PROJ-10', summary: 'Add dark mode to the settings page', status: 'Done' },
      ],
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].key, 'PROJ-9');
    assert.ok(warnings[0].similarity >= 0.5);
  });

  it('a dissimilar candidate is not flagged', () => {
    const warnings = detectDuplicates(
      { key: 'PROJ-1', fields: { summary: 'Login page crashes on Safari' } },
      [{ key: 'PROJ-10', summary: 'Add dark mode to the settings page', status: 'Done' }],
    );
    assert.equal(warnings.length, 0);
  });
});

describe('duplicate recall', () => {
  it('extractSearchTerms keeps 3-letter all-uppercase acronyms (SSO, API)', () => {
    const terms = extractSearchTerms('SSO login fails after redirect');
    assert.ok(terms.includes('sso'), `expected 'sso' in [${terms}]`);
    assert.ok(terms.includes('login'));
    assert.ok(terms.includes('redirect'));
  });

  it('3-letter mixed-case words are still dropped', () => {
    const terms = extractSearchTerms('The app is slow');
    assert.ok(!terms.includes('the'));
    assert.ok(!terms.includes('app'));
    assert.deepEqual(terms, ['slow']);
  });

  it('a 0.3–0.5 similarity candidate is possibly related, not a duplicate', () => {
    const related = findRelatedIssues(
      { key: 'PROJ-1', fields: { summary: 'Login crashes on Safari after update' } },
      [{ key: 'PROJ-9', summary: 'Login page slow on Safari', status: 'Open' }],
    );
    assert.equal(related.duplicates.length, 0);
    assert.equal(related.possiblyRelated.length, 1);
    assert.equal(related.possiblyRelated[0].key, 'PROJ-9');
    assert.ok(
      related.possiblyRelated[0].similarity >= 0.3 && related.possiblyRelated[0].similarity < 0.5,
      `expected similarity in [0.3, 0.5), got ${related.possiblyRelated[0].similarity}`,
    );
  });

  it('proposeTriage carries the possibly-related tier alongside duplicates', () => {
    const proposal = proposeTriage(
      { key: 'PROJ-1', fields: { summary: 'Login crashes on Safari after update', issuetype: { name: 'Bug' } } },
      [
        { key: 'PROJ-9', summary: 'Login page slow on Safari', status: 'Open' },
        { key: 'PROJ-10', summary: 'Login crashes on Safari after the update', status: 'Open' },
      ],
    );
    assert.equal(proposal.duplicateWarnings.length, 1);
    assert.equal(proposal.duplicateWarnings[0].key, 'PROJ-10');
    assert.equal(proposal.possiblyRelated.length, 1);
    assert.equal(proposal.possiblyRelated[0].key, 'PROJ-9');
  });
});

describe('suggestArea (keyword fallback)', () => {
  it('falls back to summary keywords when no component or label matches', () => {
    const issue = {
      fields: {
        summary: 'App crashes on login with SSO',
        description: 'Login fails after the SSO redirect.',
        issuetype: { name: 'Bug' },
      },
    };
    assert.equal(suggestArea(issue), 'Platform / Auth');
    assert.equal(suggestAreaWithSource(issue).source, 'keywords');
  });

  it('records the area source in the proposal', () => {
    const proposal = proposeTriage({
      fields: {
        summary: 'App crashes on login with SSO',
        issuetype: { name: 'Bug' },
      },
    });
    assert.equal(proposal.suggestedArea, 'Platform / Auth');
    assert.equal(proposal.suggestedAreaSource, 'keywords');
  });

  it('prefers components over keywords', () => {
    const issue = {
      fields: {
        summary: 'App crashes on login with SSO',
        components: [{ name: 'Payments' }],
        issuetype: { name: 'Bug' },
      },
    };
    assert.equal(suggestAreaWithSource(issue).source, 'component');
    assert.equal(suggestArea(issue), 'Payments');
  });
});

describe('alreadyReviewed state', () => {
  it('proposal carries alreadyReviewed and currentPriority', () => {
    const proposal = proposeTriage({
      fields: {
        summary: 'App crashes on login',
        labels: ['triagepilot-reviewed'],
        priority: { name: 'Highest' },
        issuetype: { name: 'Bug' },
      },
    });
    assert.equal(proposal.alreadyReviewed, true);
    assert.equal(proposal.currentPriority, 'Highest');
  });

  it('an unreviewed issue has alreadyReviewed false', () => {
    const proposal = proposeTriage({
      fields: {
        summary: 'App crashes on login',
        labels: [],
        issuetype: { name: 'Bug' },
      },
    });
    assert.equal(proposal.alreadyReviewed, false);
  });
});

describe('missingInfoChecklist', () => {
  it('missing description is flagged', () => {
    const checklist = missingInfoChecklist({
      fields: { summary: 'Something is broken', issuetype: { name: 'Bug' } },
    });
    assert.ok(checklist.some((item) => item.code === 'short-description'));
    assert.ok(checklist.some((item) => item.code === 'no-assignee'));
    assert.ok(checklist.some((item) => item.code === 'no-priority'));
  });

  it('a complete issue has an empty checklist', () => {
    assert.deepEqual(missingInfoChecklist(completeIssue), []);
  });

  it('a Bug without reproduction steps is flagged', () => {
    const checklist = missingInfoChecklist({
      fields: {
        summary: 'Checkout fails',
        description: 'Checkout does not work for me. Please fix it soon, this is important for our customers.',
        assignee: { displayName: 'Bo' },
        priority: { name: 'High' },
        labels: ['checkout'],
        issuetype: { name: 'Bug' },
      },
    });
    assert.ok(checklist.some((item) => item.code === 'no-repro-steps'));
  });
});

describe('proposeTriage (end to end, pure)', () => {
  it('returns a complete proposal object for a realistic issue', () => {
    const proposal = proposeTriage(
      {
        key: 'PROJ-42',
        fields: {
          summary: 'Payment page crashes on submit',
          description: 'Submitting a payment crashes the page. Expected: confirmation screen. Actual: blank page.',
          issuetype: { name: 'Bug' },
          components: [{ name: 'Payments' }],
          project: { key: 'PROJ' },
        },
      },
      [{ key: 'PROJ-7', summary: 'Payment page crashes when submitting', status: 'Open' }],
    );
    assert.equal(proposal.issueKey, 'PROJ-42');
    assert.equal(proposal.priority, 'Highest');
    assert.equal(proposal.suggestedArea, 'Payments');
    assert.equal(proposal.duplicateWarnings.length, 1);
    assert.equal(proposal.duplicateWarnings[0].key, 'PROJ-7');
    assert.ok(proposal.missingInfo.some((item) => item.code === 'no-assignee'));
    assert.ok(proposal.duplicateSearch.jql.includes('text ~'));
  });

  it('suggestArea maps components to owner areas', () => {
    assert.equal(suggestArea({ fields: { components: [{ name: 'Payments' }] } }), 'Payments');
    assert.equal(suggestArea({ fields: { labels: ['auth'] } }), 'Platform / Auth');
    assert.equal(suggestArea({ fields: {} }), 'Unassigned — needs routing');
  });

  it('ADF descriptions are converted to plain text without crashing', () => {
    const text = adfToText({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'The app crashes ' },
            { type: 'text', text: 'on login.' },
          ],
        },
      ],
    });
    assert.equal(text, 'The app crashes on login.');
    const { priority } = scorePriority({
      fields: {
        summary: 'Login problem',
        description: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'App crashes on login.' }] }],
        },
        issuetype: { name: 'Bug' },
      },
    });
    assert.equal(priority, 'Highest');
  });
});

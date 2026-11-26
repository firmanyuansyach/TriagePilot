// TriagePilot — pure deterministic triage engine.
// Zero Forge dependencies: this file runs anywhere (Node, tests, Forge
// functions). Every rule is explainable in one line and every proposal
// carries its reasons, so a human can audit it before approving.
// No network, no LLM calls, no randomness.

export const PRIORITY_LEVELS = ['Lowest', 'Low', 'Medium', 'High', 'Highest'];

// Words too common to use as duplicate-search terms (English + Indonesian).
const STOPWORDS = new Set([
  'with', 'from', 'that', 'this', 'when', 'where', 'which', 'about',
  'after', 'before', 'while', 'during', 'under', 'over', 'into', 'onto',
  'there', 'their', 'then', 'than', 'also', 'been', 'have', 'does',
  'user', 'users', 'issue', 'error', 'page', 'button', 'click', 'yang',
  'dari', 'untuk', 'dengan', 'tidak', 'sudah', 'saat', 'ketika', 'atau',
  'adalah', 'dalam', 'pada', 'jika', 'akan', 'bisa', 'juga',
]);

// Severity signals. Each rule fires at most once per issue; the weight is
// the only thing that differs, so the score is fully explainable.
const SEVERITY_RULES = [
  {
    id: 'sev-critical',
    pattern: /\b(crash|crashes|crashing|data loss|lost data|security|vulnerab\w*|breach|exploit|outage|down|unavailable|blocked|blocker|critical|sev[ -]?1|\bp0\b)\b/i,
    weight: 45,
    reason: 'Critical signal: crash, data loss, security, outage or blocker.',
  },
  {
    id: 'sev-broken',
    pattern: /\b(broken|fails?|failing|failure|regression|regressed|not working|doesn\'t work|does not work|incorrect|wrong result)\b/i,
    weight: 25,
    reason: 'Breakage signal: something that used to work now fails.',
  },
  {
    id: 'sev-performance',
    pattern: /\b(slow|slowness|timeout|timed out|hang|hangs|freez\w*|lag|latency)\b/i,
    weight: 15,
    reason: 'Performance signal: slow, timeout or hang.',
  },
  {
    id: 'sev-cosmetic',
    pattern: /\b(typo|spelling|wording|grammar|docs?|documentation|readme)\b/i,
    weight: -10,
    reason: 'Cosmetic/docs signal: wording or documentation only.',
  },
];

const LABEL_BOOSTS = [
  { pattern: /^(sev1|p0|blocker|critical|urgent)$/i, weight: 30, reason: 'Label marks it sev1 / blocker / urgent.' },
  { pattern: /^(sev2|p1|high)$/i, weight: 15, reason: 'Label marks it sev2 / high priority.' },
];

// Components whose failure has outsized blast radius.
const HIGH_IMPACT_COMPONENTS = new Set([
  'payments', 'payment', 'billing', 'checkout', 'auth', 'authentication',
  'login', 'security', 'database', 'api-gateway',
]);

// Component / label -> owner area. First match wins; components are
// checked before labels.
const AREA_MAP = [
  [/payments?|billing|checkout/i, 'Payments'],
  [/auth|login|signup|session/i, 'Platform / Auth'],
  [/frontend|ui|ux|webapp|mobile|android|ios/i, 'Frontend'],
  [/api|backend|server|database|infra/i, 'Backend / API'],
  [/docs?|documentation/i, 'Docs'],
];

const REPRO_MARKERS =
  /\b(repro|steps to reproduce|expected|actual|stack ?trace|error ?log)\b/i;

function textOf(value) {
  if (value == null) return '';
  return String(value);
}

/** Convert a Jira ADF description document to plain text. */
export function adfToText(adf) {
  if (adf == null) return '';
  if (typeof adf === 'string') return adf;
  if (typeof adf !== 'object') return textOf(adf);
  const chunks = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'text' && typeof node.text === 'string') chunks.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
    // Separate block-level nodes so paragraphs do not run together.
    if (['paragraph', 'heading', 'listItem', 'blockquote'].includes(node.type)) chunks.push(' ');
  };
  walk(adf);
  return chunks.join('').replace(/\s+/g, ' ').trim();
}

/** Normalise a raw Jira issue (or a partial one) into engine input. */
export function normalizeIssue(raw = {}) {
  const fields = raw.fields && typeof raw.fields === 'object' ? raw.fields : raw;
  const description = fields.description;
  const labels = Array.isArray(fields.labels) ? fields.labels.map(textOf) : [];
  const components = (Array.isArray(fields.components) ? fields.components : [])
    .map((c) => (c && typeof c === 'object' ? c.name : c))
    .map(textOf)
    .filter(Boolean);
  const assignee = fields.assignee
    ? (typeof fields.assignee === 'object'
      ? (fields.assignee.displayName || fields.assignee.accountId || 'assigned')
      : textOf(fields.assignee))
    : '';
  return {
    key: textOf(raw.key || fields.key || ''),
    projectKey: textOf(fields.project?.key || (raw.key || '').split('-')[0] || ''),
    summary: textOf(fields.summary || ''),
    description: adfToText(description),
    status: textOf(fields.status?.name || fields.status || ''),
    priority: textOf(fields.priority?.name || fields.priority || ''),
    assignee,
    labels,
    components,
    issueType: textOf(fields.issuetype?.name || fields.issuetype || fields.type || ''),
  };
}

// Bands calibrated to the weights above: one critical signal (45) already
// means Highest — a crash / data-loss / outage bug must not sit at Medium
// waiting for a label to push it up. Breakage alone (25) is High,
// performance alone (15) is Medium, no signal at all is Lowest.
function scoreToPriority(score) {
  if (score >= 45) return 'Highest';
  if (score >= 30) return 'High';
  if (score >= 15) return 'Medium';
  if (score >= 5) return 'Low';
  return 'Lowest';
}

/**
 * Score an issue's priority from severity keywords, labels, component
 * blast radius and issue type. Returns { score, priority, reasons }.
 * A priority already set in Jira is respected as a floor: the proposal
 * never downgrades an explicitly set priority.
 */
export function scorePriority(rawIssue) {
  const issue = normalizeIssue(rawIssue);
  const haystack = `${issue.summary} ${issue.description}`;
  let score = 0;
  const reasons = [];

  for (const rule of SEVERITY_RULES) {
    if (rule.pattern.test(haystack)) {
      score += rule.weight;
      reasons.push(rule.reason);
    }
  }
  for (const label of issue.labels) {
    for (const boost of LABEL_BOOSTS) {
      if (boost.pattern.test(label)) {
        score += boost.weight;
        reasons.push(boost.reason);
        break;
      }
    }
  }
  for (const component of issue.components) {
    if (HIGH_IMPACT_COMPONENTS.has(component.toLowerCase())) {
      score += 10;
      reasons.push(`High-impact component: ${component}.`);
      break;
    }
  }
  if (/^bug$/i.test(issue.issueType)) {
    score += 5;
    reasons.push('Issue type is Bug.');
  }
  if (reasons.length === 0) {
    reasons.push('No severity signals in summary, description or labels.');
  }

  score = Math.max(0, Math.min(100, score));
  let priority = scoreToPriority(score);
  // Respect an explicitly set Jira priority as a floor.
  const current = issue.priority;
  if (current && PRIORITY_LEVELS.includes(current)) {
    const currentIdx = PRIORITY_LEVELS.indexOf(current);
    const proposedIdx = PRIORITY_LEVELS.indexOf(priority);
    if (currentIdx > proposedIdx) {
      priority = current;
      reasons.push(`Keeping the priority already set in Jira (${current}).`);
    }
  } else if (current) {
    // Non-standard priority (e.g. a site-specific "Critical" level that
    // is not one of the five standard levels): it has no defined order
    // against the standard levels, so never propose below it — keep it
    // as the proposal. applyApproval leaves such a priority unchanged
    // instead of trying to write it (it cannot be validated as standard).
    priority = current;
    reasons.push(
      `Keeping the non-standard priority already set in Jira (${current}) — ` +
      'it is outside the standard levels, so no lower priority is proposed.',
    );
  }
  return { score, priority, reasons };
}

/** Distinctive words of a summary, for duplicate search. */
export function extractSearchTerms(summary) {
  const terms = [];
  for (const word of textOf(summary).split(/[^\p{L}\p{N}]+/u)) {
    if (isSearchToken(word)) terms.push(word.toLowerCase());
  }
  return [...new Set(terms)].slice(0, 6);
}

/** Build a JQL query that finds issues with a similar summary. */
export function buildDuplicateJql(summary, projectKey = '') {
  const terms = extractSearchTerms(summary);
  if (terms.length === 0) return { jql: null, terms };
  const clauses = terms.map((t) => `text ~ "${t}"`).join(' OR ');
  const project = projectKey ? `project = "${projectKey}" AND ` : '';
  return { jql: `${project}(${clauses}) ORDER BY updated DESC`, terms };
}

/**
 * What is missing from this issue before it can be triaged well?
 * Each item is one concrete, checkable fact — never a guess.
 */
export function missingInfoChecklist(rawIssue) {
  const issue = normalizeIssue(rawIssue);
  const checklist = [];
  if (!issue.assignee) {
    checklist.push({
      code: 'no-assignee',
      message: 'No assignee — nobody owns this yet.',
    });
  }
  if (!issue.description || issue.description.trim().length < 30) {
    checklist.push({
      code: 'short-description',
      message: 'Description is missing or too short to triage from.',
    });
  } else if (/^bug$/i.test(issue.issueType) && !REPRO_MARKERS.test(issue.description)) {
    checklist.push({
      code: 'no-repro-steps',
      message: 'No reproduction steps (expected / actual / steps) in the description.',
    });
  }
  if (!issue.priority) {
    checklist.push({
      code: 'no-priority',
      message: 'Priority is not set in Jira.',
    });
  }
  if (issue.components.length === 0 && issue.labels.length === 0) {
    checklist.push({
      code: 'no-routing',
      message: 'No component or label — routing to an owner area is a guess.',
    });
  }
  return checklist;
}

/**
 * Suggest an owner area, with the source of the match.
 * Components are checked first, then labels, then — as a fallback —
 * keyword matching against summary + description (so an issue with no
 * component or label can still be routed, e.g. "crashes on login"
 * -> Platform / Auth). Returns { area, source } where source is one of
 * 'component' | 'label' | 'keywords' | 'none'.
 */
export function suggestAreaWithSource(rawIssue) {
  const issue = normalizeIssue(rawIssue);
  for (const name of issue.components) {
    for (const [pattern, area] of AREA_MAP) {
      if (pattern.test(name)) return { area, source: 'component' };
    }
  }
  for (const name of issue.labels) {
    for (const [pattern, area] of AREA_MAP) {
      if (pattern.test(name)) return { area, source: 'label' };
    }
  }
  const haystack = `${issue.summary} ${issue.description}`;
  for (const [pattern, area] of AREA_MAP) {
    if (pattern.test(haystack)) return { area, source: 'keywords' };
  }
  return { area: 'Unassigned — needs routing', source: 'none' };
}

/** Suggest an owner area from components first, then labels, then keywords. */
export function suggestArea(rawIssue) {
  return suggestAreaWithSource(rawIssue).area;
}

/**
 * Is this word distinctive enough to search / compare on? Words of 4+
 * letters, plus 3-letter ALL-UPPERCASE tokens — those are acronyms
 * (SSO, API, UI is 2 letters and stays out). Case is checked on the
 * raw word, before lowercasing, or "SSO" would look like any 3-letter word.
 */
function isSearchToken(word) {
  if (!word) return false;
  const lower = word.toLowerCase();
  if (STOPWORDS.has(lower)) return false;
  if (lower.length >= 4) return true;
  return lower.length === 3 && word === word.toUpperCase() && /[A-Z]/.test(word);
}

function tokenSet(text) {
  const tokens = new Set();
  for (const word of textOf(text).split(/[^\p{L}\p{N}]+/u)) {
    if (isSearchToken(word)) tokens.add(word.toLowerCase());
  }
  return tokens;
}

/**
 * Flag candidates whose summary is likely the same problem, plus a
 * "possibly related" tier for weaker matches. Jaccard similarity of
 * distinctive summary tokens: >= 0.5 is a duplicate warning, 0.3–0.5
 * is possibly related. Each tier is sorted by similarity, capped at 3.
 */
export function findRelatedIssues(rawIssue, candidates = []) {
  const issue = normalizeIssue(rawIssue);
  const base = tokenSet(issue.summary);
  const duplicates = [];
  const possiblyRelated = [];
  if (base.size === 0) return { duplicates, possiblyRelated };
  for (const candidate of candidates || []) {
    const key = textOf(candidate.key || '');
    if (!key || key === issue.key) continue;
    const other = tokenSet(candidate.summary || '');
    if (other.size === 0) continue;
    let intersection = 0;
    for (const token of base) if (other.has(token)) intersection += 1;
    const union = new Set([...base, ...other]).size;
    const similarity = union === 0 ? 0 : Math.round((intersection / union) * 100) / 100;
    const entry = {
      key,
      summary: textOf(candidate.summary || ''),
      status: textOf(candidate.status || ''),
      similarity,
    };
    if (similarity >= 0.5) duplicates.push(entry);
    else if (similarity >= 0.3) possiblyRelated.push(entry);
  }
  duplicates.sort((a, b) => b.similarity - a.similarity);
  possiblyRelated.sort((a, b) => b.similarity - a.similarity);
  return { duplicates: duplicates.slice(0, 3), possiblyRelated: possiblyRelated.slice(0, 3) };
}

/**
 * Flag candidates whose summary is likely the same problem.
 * Jaccard similarity of distinctive summary tokens, threshold 0.5.
 * Kept for callers that only need the duplicate tier; see
 * findRelatedIssues for the possibly-related tier as well.
 */
export function detectDuplicates(rawIssue, candidates = []) {
  return findRelatedIssues(rawIssue, candidates).duplicates;
}

/** Full proposal for one issue. `similarIssues` are JQL search results. */
export function proposeTriage(rawIssue, similarIssues = []) {
  const issue = normalizeIssue(rawIssue);
  const { score, priority, reasons } = scorePriority(issue);
  const duplicateSearch = buildDuplicateJql(issue.summary, issue.projectKey);
  const area = suggestAreaWithSource(issue);
  const related = findRelatedIssues(issue, similarIssues);
  return {
    issueKey: issue.key,
    priority,
    priorityScore: score,
    reasons,
    suggestedArea: area.area,
    suggestedAreaSource: area.source,
    duplicateWarnings: related.duplicates,
    possiblyRelated: related.possiblyRelated,
    missingInfo: missingInfoChecklist(issue),
    duplicateSearch,
    alreadyReviewed: issue.labels.includes('triagepilot-reviewed'),
    currentPriority: issue.priority || '',
  };
}

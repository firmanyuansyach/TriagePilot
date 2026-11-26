import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Button,
  Heading,
  Lozenge,
  SectionMessage,
  Stack,
  Text,
  useProductContext,
} from '@forge/react';
import { invoke } from '@forge/bridge';

// TriagePilot issue panel (UI Kit 2).
// Shows the triage proposal for the issue on screen. The human decides:
// Approve applies the proposal to Jira (the only write path in the app),
// Dismiss leaves the issue untouched. The priority actually applied is
// recomputed server-side at approve time — the panel never sends a
// priority value for the backend to trust.

const PRIORITY_LOZENGE_APPEARANCE = {
  Highest: 'danger',
  Critical: 'danger',
  High: 'warning',
  Medium: 'information',
  Low: 'neutral',
  Lowest: 'default',
};

const AREA_SOURCE_LABEL = {
  component: 'from component',
  label: 'from label',
  keywords: 'from summary keywords',
  none: '',
};

const App = () => {
  const context = useProductContext();
  const issueKey = context?.extension?.issue?.key;
  const [proposal, setProposal] = useState(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    if (!issueKey) return;
    setError('');
    setDone('');
    invoke('getProposal', { issueKey })
      .then(setProposal)
      .catch((err) => setError(`Could not load the TriagePilot proposal: ${err.message}`));
  }, [issueKey]);

  const approve = async () => {
    setError('');
    try {
      // No priority is sent: the backend recomputes the proposal
      // server-side and applies ITS priority.
      const result = await invoke('applyApproval', { issueKey, approved: true });
      let message = result && result.priority
        ? `Applied: priority set to ${result.priority}.`
        : 'Applied: priority left unchanged; label and audit comment added.';
      if (result && result.commentPosted === false) {
        message += ' (Audit comment could not be posted.)';
      }
      setDone(message);
    } catch (err) {
      setError(`Apply failed: ${err.message}`);
    }
  };

  const dismiss = async () => {
    setError('');
    try {
      await invoke('dismissProposal', { issueKey });
      setDone('Proposal dismissed — nothing was changed in Jira.');
    } catch (err) {
      setError(`Dismiss failed: ${err.message}`);
    }
  };

  if (!issueKey) return <Text>Loading TriagePilot…</Text>;
  if (error) return <Text>{error}</Text>;
  if (!proposal) return <Text>Analysing {issueKey}…</Text>;

  const areaSource = AREA_SOURCE_LABEL[proposal.suggestedAreaSource] || '';
  const lozengeAppearance = PRIORITY_LOZENGE_APPEARANCE[proposal.priority] || 'neutral';

  return (
    <Stack space="space.100">
      <Heading size="medium">Triage proposal</Heading>
      <Lozenge appearance={lozengeAppearance}>{proposal.priority}</Lozenge>
      <Text>
        Proposed priority: {proposal.priority} (severity score {proposal.priorityScore})
      </Text>
      {proposal.reasons.map((reason) => (
        <Text key={reason}>• {reason}</Text>
      ))}
      <Text>
        Suggested owner area: {proposal.suggestedArea}
        {areaSource ? ` (${areaSource})` : ''}
      </Text>

      {proposal.duplicateWarnings.length > 0 && (
        <SectionMessage title="Possible duplicates — check before triaging" appearance="warning">
          <Stack space="space.050">
            {proposal.duplicateWarnings.map((dup) => (
              <Text key={dup.key}>
                • {dup.key}: {dup.summary} ({dup.status}, similarity {dup.similarity})
              </Text>
            ))}
          </Stack>
        </SectionMessage>
      )}

      {proposal.possiblyRelated && proposal.possiblyRelated.length > 0 && (
        <Stack space="space.050">
          <Text>Possibly related:</Text>
          {proposal.possiblyRelated.map((rel) => (
            <Text key={rel.key}>
              • {rel.key}: {rel.summary} ({rel.status}, similarity {rel.similarity})
            </Text>
          ))}
        </Stack>
      )}

      {proposal.missingInfo.length > 0 && (
        <Stack space="space.050">
          <Text>Missing information:</Text>
          {proposal.missingInfo.map((item) => (
            <Text key={item.code}>• {item.message}</Text>
          ))}
        </Stack>
      )}
      {proposal.missingInfo.length === 0 && (
        <Text>Nothing missing — this issue is ready to triage.</Text>
      )}

      {proposal.linkedPages && proposal.linkedPages.length > 0 && (
        <Stack space="space.050">
          <Text>Linked Confluence pages:</Text>
          {proposal.linkedPages.map((page) => (
            <Stack key={page.url} space="space.050">
              <Text>• {page.title}</Text>
              {page.excerpt ? (
                <Text>
                  {page.excerpt.length > 200 ? `${page.excerpt.slice(0, 200)}…` : page.excerpt}
                </Text>
              ) : null}
            </Stack>
          ))}
        </Stack>
      )}

      {proposal.alreadyReviewed ? (
        <Text>
          Already reviewed — priority {proposal.currentPriority || proposal.priority} was applied.
        </Text>
      ) : done ? (
        <Text>{done}</Text>
      ) : (
        <Stack space="space.100">
          <Button appearance="primary" onClick={approve}>
            Approve — apply to Jira
          </Button>
          <Button onClick={dismiss}>Dismiss — change nothing</Button>
        </Stack>
      )}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

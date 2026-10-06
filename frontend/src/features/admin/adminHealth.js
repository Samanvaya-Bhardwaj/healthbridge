/** Plain names for the background-job queues. */
export const QUEUE_NAMES = {
  notifications: 'Notifications (email and in-app)',
  payments: 'Payments and refunds',
  appointments: 'Appointment reminders and expiry',
  maintenance: 'Housekeeping',
  documents: 'Document safety checks and reading',
  timeline: 'Health timeline',
  followups: 'Follow-up check-ins',
  outbox: 'Outbox relay',
};

/**
 * Overall platform job health from the operations summary, worst state first:
 * unreachable queue → jobs that gave up / failures → healthy.
 */
export function platformHealth(summary) {
  const openDead = summary.deadLetters?.open ?? 0;
  if (!summary.queues) {
    return {
      tone: 'error',
      title: 'Job queue unreachable',
      text: 'Events wait safely in the outbox and are relayed when the queue returns. Check Redis and the worker.',
    };
  }
  const failed = Object.values(summary.queues).reduce((n, q) => n + (q.failed ?? 0), 0);
  const outboxFailed = summary.outbox?.failed ?? 0;
  if (openDead || failed || outboxFailed) {
    return {
      tone: 'warning',
      title: 'Needs attention',
      text: [
        openDead &&
          `${openDead} job${openDead === 1 ? '' : 's'} gave up after all automatic attempts`,
        failed && `${failed} failed in a queue`,
        outboxFailed && `${outboxFailed} outbox event${outboxFailed === 1 ? '' : 's'} failed`,
      ]
        .filter(Boolean)
        .join(' · '),
    };
  }
  return {
    tone: 'success',
    title: 'Healthy',
    text: 'All background jobs are completing normally.',
  };
}

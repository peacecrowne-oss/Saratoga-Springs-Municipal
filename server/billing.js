// Billing requests against Caselle (STORY-010). Used by the API and by the
// headless Caselle job, so both follow the same rules and leave the same record.
//
// Every request is audited with who made it and when: a lookup that succeeds is
// written before the data is returned, so if the audit write fails the data is
// withheld. Failures and refusals are written too. The customer's name and
// address are not put in the audit trail.

import { ACCOUNT_NUMBER, CaselleIntegrationError } from './integrations/caselle/client.js';

const CONNECTION_KINDS = ['not_configured', 'unreachable', 'timeout', 'refused'];

export function createBilling({ audit, caselle }) {
  return {
    // Returns { status, body } ready to send.
    async lookup({ actor, accountNumber, context = {} }) {
      const event = { actor, entityType: 'billing', entityId: String(accountNumber).slice(0, 64) };
      if (typeof accountNumber !== 'string' || !ACCOUNT_NUMBER.test(accountNumber)) {
        audit.record({ ...event, action: 'billing.lookup_refused', after: { reason: 'invalid_account_number', ...context } });
        return { status: 400, body: { error: { kind: 'bad_request', message: 'An account number is 1 to 32 letters, digits or dashes.' } } };
      }

      let result;
      try {
        result = await caselle.fetchAccount(accountNumber);
      } catch (err) {
        if (!(err instanceof CaselleIntegrationError)) throw err;
        const connected = !CONNECTION_KINDS.includes(err.kind);
        audit.record({ ...event, action: 'billing.lookup_failed', after: { kind: err.kind, message: err.message, connected, ...context } });
        if (err.kind === 'not_found') return { status: 404, body: { connected: true, error: { kind: err.kind, message: err.message } } };
        const message = connected
          ? `Caselle answered, but its billing data could not be used: ${err.message}`
          : `Cannot connect to Caselle, so billing information is unavailable: ${err.message}`;
        return { status: 502, body: { connected, error: { kind: err.kind, message } } };
      }

      const { account } = result;
      audit.record({ ...event, action: 'billing.lookup', after: {
        accountStatus: account.status, balanceCents: account.balanceCents, bills: account.bills.length,
        asOf: result.asOf, simulated: result.simulated, ...context,
      } });
      return { status: 200, body: { connected: true, ...result } };
    },
  };
}

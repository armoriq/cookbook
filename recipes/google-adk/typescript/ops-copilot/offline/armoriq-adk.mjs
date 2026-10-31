// Offline stand-in for @armoriq/sdk/dist/integrations/google_adk. Same surface ask.ts uses
// (ArmorIQADK, forUser, install, uninstall, close), with the README Step 9 policy checked locally:
//   reads-allowed                  allow
//   money-needs-approval           hold above the user's refund limit
//   account-changes-need-approval  hold
//   destructive-ops-denied         block
// Anything not named is blocked (fail closed). Held actions are approved after a short pause,
// or refused when OFFLINE_APPROVAL=reject, standing in for a human in the ArmorIQ console.

const READS = ['lookup_customer', 'get_subscription', 'get_invoices', 'get_ticket', 'list_tickets', 'add_account_note', 'reply_to_ticket', 'extend_trial'];
const MONEY = ['issue_refund', 'apply_discount'];
const ACCOUNT_CHANGES = ['change_plan', 'suspend_account'];
const DESTRUCTIVE = ['export_all_customers', 'impersonate_user', 'grant_admin_role', 'delete_account'];

// The two users from README Step 9.
const REFUND_LIMITS = { 'support-t1@example.com': ['support_t1', 500], 'manager@example.com': ['manager', 10000] };

const money = (n) => `$${Number(n).toFixed(2)}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ArmorIQADK {
  constructor(options) {
    this.options = options;
  }

  async forUser(userEmail, { onEvent = () => {} } = {}) {
    const [role, limit] = REFUND_LIMITS[userEmail] ?? ['unknown_user', 0];

    async function holdThenDecide(tool, reason) {
      onEvent('hold', { tool, reason });
      await pause(800);
      if (process.env.OFFLINE_APPROVAL === 'reject') {
        onEvent('rejected', { tool });
        return { armoriq_enforcement: { action: 'hold', outcome: 'rejected', reason } };
      }
      onEvent('approved', { tool });
      return undefined;
    }

    async function beforeToolCallback({ tool, args }) {
      const name = tool.name;
      if (READS.includes(name)) return undefined;
      if (MONEY.includes(name)) {
        const amount = Number(args?.amount ?? 0);
        if (amount <= limit) return undefined;
        return holdThenDecide(name, `${money(amount)} exceeds the ${role} refund limit of ${money(limit)}`);
      }
      if (ACCOUNT_CHANGES.includes(name)) return holdThenDecide(name, 'account changes need approval');
      const reason = DESTRUCTIVE.includes(name)
        ? 'destructive operation, not available to agents'
        : 'no policy allows this tool (closed by default)';
      onEvent('block', { tool: name, reason });
      return { armoriq_enforcement: { action: 'block', reason } };
    }

    return {
      install(agent) {
        agent.beforeToolCallback = beforeToolCallback;
      },
      uninstall(agent) {
        if (agent.beforeToolCallback === beforeToolCallback) agent.beforeToolCallback = undefined;
      },
      async close() {},
    };
  }
}

export class ArmorIQADKBundle {}

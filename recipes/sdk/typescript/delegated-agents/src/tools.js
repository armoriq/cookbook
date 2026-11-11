// The incident toolbox, run through ArmorIQ's invoke() with whatever token an agent holds.
//
// This is the raw client pattern from the ArmorIQ docs ("Custom frameworks"). Each toolbox is bound
// to one Authority: the token an agent was given. The lead's tools carry the lead's intent token;
// the analyst's tools carry the narrower token that client.delegate() returned. Same tool code,
// different authority.

import { ArmorIQException, PolicyBlockedException } from '@armoriq/sdk';

const service = { type: 'string', description: "Service name, e.g. 'checkout'" };
const CATALOG = [
  { name: 'get_metrics', description: 'Read current latency, error rate, CPU, and connection pool metrics for a service.',
    parameters: { type: 'object', properties: { service }, required: ['service'] } },
  { name: 'search_logs', description: "Search the last 15 minutes of a service's logs for lines containing a query.",
    parameters: { type: 'object', properties: { service, query: { type: 'string', description: "Text to look for, e.g. 'error'" } }, required: ['service', 'query'] } },
  { name: 'restart_service', description: 'Rolling restart of every instance of a service. Drops in flight requests.',
    parameters: { type: 'object', properties: { service }, required: ['service'] } },
];

// authority: { agent, client, token, userEmail, mcp }. `agent` is a label for logs and refusals.
export function incidentTools(authority) {
  return CATALOG.map((tool) => ({
    ...tool,
    async run(params) {
      try {
        const { result } = await authority.client.invoke(authority.mcp, tool.name, authority.token, params, authority.userEmail);
        return JSON.stringify(result);
      } catch (e) {
        // Hand the refusal back to the model as an observation, so the agent can adapt.
        if (e instanceof PolicyBlockedException) {
          return `REFUSED by ArmorIQ: ${authority.agent} may not call ${tool.name} (${e.reason ?? e.message}). Escalate to whoever holds that authority.`;
        }
        if (e instanceof ArmorIQException) return `REFUSED by ArmorIQ: ${e.constructor.name}: ${e.message}`;
        throw e;
      }
    },
  }));
}

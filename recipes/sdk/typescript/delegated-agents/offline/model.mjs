// Offline stand-in for src/model.js: a scripted model, so the demo needs no Gemini key and always
// takes the same path. Same generate() signature. It picks its next move from the agent's role
// (named in the system prompt) and how many tool results it has already seen.

export const MODEL = 'offline-scripted-model';

const call = (name, args) => [{ functionCall: { name, args } }];
const checkout = { service: 'checkout' };

export async function generate({ system, contents }) {
  const seen = contents.flatMap((c) => c.parts).filter((p) => p.functionResponse);
  const last = seen.at(-1)?.functionResponse.response.result ?? '';

  if (system.includes('Log Analyst')) {
    if (seen.length === 0) return call('get_metrics', checkout);
    if (seen.length === 1) return call('search_logs', { ...checkout, query: 'error' });
    if (seen.length === 2) return call('restart_service', checkout); // the analyst reaches for the restart button
    return [{ text: last.startsWith('REFUSED')
      ? 'Checkout p95 is 4210ms against a 380ms baseline with all 200 database connections in use, and the logs suggest a connection leak in CartRepository.refresh. I tried to restart checkout but ArmorIQ refused it for my token, so the Incident Lead needs to restart it.'
      : 'Checkout was restarted.' }];
  }

  if (seen.length === 0) return call('restart_service', checkout);
  return [{ text: last.startsWith('REFUSED')
    ? 'The restart was refused, so checkout is still degraded.'
    : 'Checkout latency was caused by an exhausted database connection pool, suspected connection leak in CartRepository.refresh. The incident lead restarted checkout (6 instances); the log analyst diagnosed it with read only access.' }];
}

// Offline stand-in for @langchain/openai: a scripted tool calling chat model. It plays the part
// OpenAI plays in the live run and picks one tool call per turn from the request. It returns real
// AIMessage tool calls, so the graph's policy_gate, human_review, and run_tools nodes see exactly what
// they would see from a live model.

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';

// Tool calls the model "decides" on, in order, for a request.
function script(request) {
  if (request.toLowerCase().includes('disk')) {
    return [
      ['get_service_status', { service: 'db-primary' }],
      // The shortcut a tired human might take, and the one the policy exists to stop.
      ['delete_volume', { volume: 'db-primary-wal-archive' }],
    ];
  }
  return [
    ['get_service_status', { service: 'checkout-api' }],
    ['read_recent_logs', { service: 'checkout-api', lines: 20 }],
    [
      'restart_service',
      { service: 'checkout-api', reason: 'Connection pool to payments-db exhausted; pool_size=200 takes effect on restart.' },
    ],
  ];
}

function finalAnswer(results) {
  const refused = results.filter((r) => r.startsWith('ArmorIQ'));
  if (refused.length > 0) return `I could not finish. ${refused.join(' | ')} A human on-call engineer should take it from here.`;
  return 'Done. checkout-api was restarted with the larger connection pool and is healthy again.';
}

export class ChatOpenAI extends BaseChatModel {
  _llmType() {
    return 'offline-scripted';
  }

  bindTools() {
    return this;
  }

  async _generate(messages) {
    const request = String(messages.find((m) => m.getType() === 'human').content);
    const results = messages.filter((m) => m.getType() === 'tool').map((m) => String(m.content));
    const done = messages.filter((m) => m.getType() === 'ai' && m.tool_calls?.length).length;
    const steps = script(request);
    const message =
      done < steps.length
        ? new AIMessage({ content: '', tool_calls: [{ name: steps[done][0], args: steps[done][1], id: `offline-${done + 1}` }] })
        : new AIMessage(finalAnswer(results));
    return { generations: [{ text: String(message.content), message }] };
  }
}

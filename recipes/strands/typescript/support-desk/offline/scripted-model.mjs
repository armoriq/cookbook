// A scripted Strands model that stands in for Gemini. It picks tool calls from the user's request,
// one per model turn, and finishes with a short answer once the script is done.

import { Model } from '@strands-agents/sdk';

const script = (request) => {
  if (request.includes('TCK-1002')) {
    // The model reads the injected ticket, believes it, and tries to comply.
    return [
      ['get_ticket', { ticket_id: 'TCK-1002' }],
      ['issue_refund', { ticket_id: 'TCK-1002', amount: 5000 }],
      ['close_account', { account_id: 'ACC-2002' }],
    ];
  }
  if (request.includes('TCK-1003')) {
    return [
      ['get_ticket', { ticket_id: 'TCK-1003' }],
      ['issue_refund', { ticket_id: 'TCK-1003', amount: 45 }],
    ];
  }
  return [
    ['get_ticket', { ticket_id: 'TCK-1001' }],
    ['reply_to_ticket', { ticket_id: 'TCK-1001', message: 'Sorry your order arrived late. A $10 credit is on the way.' }],
  ];
};

const textOf = (block) => (block.type === 'textBlock' ? block.text : JSON.stringify(block.value ?? block));

function toolResults(messages) {
  return messages
    .flatMap((m) => m.content)
    .filter((b) => b.type === 'toolResultBlock')
    .map((b) => b.content.map(textOf).join(' '));
}

const finalAnswer = (results) => {
  const refused = results.filter((r) => r.includes('ArmorIQ'));
  return refused.length > 0
    ? `ArmorIQ stopped part of that request, so I did not complete it. ${refused.join(' | ')}`
    : 'Done. Every step I took was allowed by policy.';
};

export class ScriptedModel extends Model {
  config = { modelId: 'scripted-offline-model' };
  updateConfig(config) {
    this.config = { ...this.config, ...config };
  }
  getConfig() {
    return this.config;
  }

  async *stream(messages) {
    const request = messages.find((m) => m.role === 'user')?.content.find((b) => b.type === 'textBlock')?.text ?? '';
    const steps = script(request);
    const done = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.content).filter((b) => b.type === 'toolUseBlock').length;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (done < steps.length) {
      const [name, args] = steps[done];
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name, toolUseId: `offline-${done + 1}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(args) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else {
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: finalAnswer(toolResults(messages)) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
    yield { type: 'modelMetadataEvent', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, metrics: { latencyMs: 0 } };
  }
}

export const buildModel = () => new ScriptedModel();

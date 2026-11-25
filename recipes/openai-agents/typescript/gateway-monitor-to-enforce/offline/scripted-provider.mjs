// A scripted stand-in for OpenAI behind the offline gateway. It reads the conversation in
// Chat Completions format and returns { content, calls: [[name, args], ...] } for the next
// turn, the way a real model would for an accounts payable request.

const goalOf = (messages) => String(messages.find((m) => m.role === 'user')?.content ?? '');

// Tool calls the agent has already made, by name, with their results.
function called(messages) {
  const results = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]));
  const out = {};
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) out[call.function.name] = results.get(call.id) ?? null;
  }
  return out;
}

const money = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function respond(messages) {
  const invoiceId = goalOf(messages).match(/INV-\d+/)?.[0] ?? 'INV-1042';
  const done = called(messages);
  if (!('lookup_invoice' in done)) return { content: null, calls: [['lookup_invoice', { invoice_id: invoiceId }]] };

  const invoice = JSON.parse(done.lookup_invoice || '{}');
  const amount = Number(invoice.amount ?? 0);
  if (!('record_payment' in done)) {
    return {
      content: `${invoiceId} from ${invoice.supplier} is approved for $${money(amount)}. Recording the payment.`,
      calls: [['record_payment', { invoice_id: invoiceId, amount }]],
    };
  }
  return { content: `Paid ${invoiceId}: $${money(amount)} to ${invoice.supplier}.`, calls: [] };
}

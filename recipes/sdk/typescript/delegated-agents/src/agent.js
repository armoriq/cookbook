// A tiny agent loop, no framework: the model asks for a tool, the loop runs it through ArmorIQ,
// the result goes back to the model, until the model answers in plain text.

import { generate } from './model.js';

const MAX_TURNS = 8;
const say = (line) => console.log(`[agent] ${line}`);

export async function runAgent({ name, system, task, tools }) {
  const declarations = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const contents = [{ role: 'user', parts: [{ text: task }] }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const parts = await generate({ system, contents, declarations });
    contents.push({ role: 'model', parts });

    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (calls.length === 0) return parts.map((p) => p.text ?? '').join('').trim();

    const responses = [];
    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.name);
      const output = tool ? await tool.run(call.args ?? {}) : `No such tool: ${call.name}`;
      say(`${name}: ${call.name}(${JSON.stringify(call.args ?? {})}) -> ${output}`);
      responses.push({ functionResponse: { name: call.name, response: { result: output } } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return 'Stopped after too many steps.';
}

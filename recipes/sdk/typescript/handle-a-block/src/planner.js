// Turns a goal into tool calls with Gemini. One call per plan, JSON out, no framework.
//
// plan() returns a list of { action, params }. `avoid` lists tools the policy already refused, so a
// re-plan has to find another way. `done` lists steps that already ran, so a re-plan does not repeat them.

export const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

const SYSTEM =
  'You plan tool calls for a release engineering assistant. Reply with JSON only, in the shape ' +
  '{"steps": [{"action": "<tool name>", "params": {...}}]}. Use only the tools listed, with the ' +
  'argument names from their schemas. Plan the fewest steps that reach the goal. Never use a tool ' +
  "listed under 'Do not use'. If no allowed tool can reach the goal, return the closest safe step " +
  '(for example, filing a request for a human) or an empty list.';

export async function plan(goal, tools, { avoid = [], done = [] } = {}) {
  const names = new Set(tools.map((t) => t.name));
  const prompt = JSON.stringify(
    { goal, tools, 'Do not use (refused by policy)': avoid, 'Already done (do not repeat)': done },
    null,
    2,
  );
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });
  if (!response.ok) throw new Error(`Gemini returned HTTP ${response.status}`);
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  const parsed = JSON.parse(text);
  const steps = Array.isArray(parsed) ? parsed : (parsed.steps ?? []);
  // Drop anything the model invented or was told not to use.
  return steps
    .filter((s) => s && names.has(s.action) && !avoid.includes(s.action))
    .map((s) => ({ action: s.action, params: s.params ?? {} }));
}

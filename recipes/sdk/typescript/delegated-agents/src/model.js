// One Gemini call with function calling, over REST. Any model that takes a system prompt, a
// conversation, and tool declarations, and answers with text or tool calls, can replace this file.
//
// generate() takes Gemini style `contents` and returns the model's `parts`: text parts, or
// functionCall parts when the model wants a tool.

export const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

export async function generate({ system, contents, declarations }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: declarations }],
      generationConfig: { temperature: 0 },
    }),
  });
  if (!response.ok) throw new Error(`Gemini returned HTTP ${response.status}`);
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts ?? [{ text: '' }];
}

// Module resolve hook for offline mode (see register.mjs). It swaps two imports for local stand-ins:
// the ArmorIQ SDK and the OpenAI chat model. LangGraph itself (StateGraph, interrupt, Command,
// MemorySaver) is not replaced.

const here = new URL('./', import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@armoriq/sdk') {
    return { url: new URL('armoriq-sdk.mjs', here).href, format: 'module', shortCircuit: true };
  }
  if (specifier === '@langchain/openai') {
    return { url: new URL('model.mjs', here).href, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

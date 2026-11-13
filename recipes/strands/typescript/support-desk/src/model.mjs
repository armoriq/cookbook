// The model behind the agent. Offline mode swaps this file for a scripted model; nothing else changes.

import { GoogleModel } from '@strands-agents/sdk/models/google';

export function buildModel() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('[ERROR] GEMINI_API_KEY is required. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  return new GoogleModel({
    apiKey: process.env.GEMINI_API_KEY,
    modelId: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  });
}

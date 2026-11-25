// Reads the release-desk tool catalog over MCP stdio, so the planner knows what it can ask for.
//
// The agent never calls a release-desk tool itself: every call goes through ArmorIQ's invoke,
// and ArmorIQ's proxy forwards it to the MCP server you registered. This file only answers
// "which tools exist and what arguments do they take".

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const SERVER = new URL('./releaseDeskMcp.js', import.meta.url).pathname;

let cached;

export async function listTools() {
  if (cached) return cached;
  const client = new Client({ name: 'release-desk-catalog', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
  try {
    const listed = await client.listTools();
    cached = listed.tools.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema }));
  } finally {
    await client.close();
  }
  return cached;
}

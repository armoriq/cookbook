// Small incident-ops MCP server: two reads and one remediation action, with canned data.
// Nothing is really restarted. The answers look like what a real observability stack would return.
//
//   node src/incidentOpsMcp.js           stdio
//   node src/incidentOpsMcp.js --http    streamable HTTP on http://127.0.0.1:8000/mcp

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const METRICS = {
  checkout: { p95_latency_ms: 4210, baseline_p95_ms: 380, error_rate: 0.031, cpu: 0.22, open_db_connections: 200, db_pool_max: 200 },
};
const LOGS = {
  checkout: [
    '12:04:11 WARN  db-pool: waiting for connection (200/200 in use)',
    '12:04:12 ERROR request timed out after 4000ms: GET /cart',
    '12:04:15 WARN  db-pool: connection leak suspected in CartRepository.refresh',
  ],
};

const known = (service) => {
  if (!METRICS[service]) throw new Error(`Unknown service: ${service}`);
};

export const TOOLS = [
  { name: 'get_metrics', description: 'Read current latency, error rate, CPU, and connection pool metrics for a service.',
    inputSchema: { type: 'object', properties: { service: { type: 'string', description: "Service name, e.g. 'checkout'" } }, required: ['service'] },
    run: ({ service }) => (known(service), { service, ...METRICS[service] }) },
  { name: 'search_logs', description: "Search the last 15 minutes of a service's logs for lines containing a query.",
    inputSchema: { type: 'object', properties: { service: { type: 'string', description: "Service name, e.g. 'checkout'" }, query: { type: 'string', description: "Text to look for, e.g. 'error'" } }, required: ['service', 'query'] },
    run: ({ service, query }) => {
      const all = LOGS[service] ?? [];
      const hits = all.filter((line) => line.toLowerCase().includes(String(query).toLowerCase()));
      return { service, query, lines: hits.length ? hits : all };
    } },
  { name: 'restart_service', description: 'Rolling restart of every instance of a service. Drops in flight requests.',
    inputSchema: { type: 'object', properties: { service: { type: 'string', description: "Service name, e.g. 'checkout'" } }, required: ['service'] },
    run: ({ service }) => (known(service), { service, status: 'restarted', instances: 6 }) },
];

function makeServer() {
  const server = new Server({ name: 'incident-ops', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) throw new Error(`Unknown tool: ${params.name}`);
      return { content: [{ type: 'text', text: JSON.stringify(tool.run(params.arguments ?? {})) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--http')) {
    // Stateless: a fresh server and transport per request. ArmorIQ's proxy calls this URL.
    createServer(async (req, res) => {
      if (req.url !== '/mcp') return void res.writeHead(404).end();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close());
      await makeServer().connect(transport);
      await transport.handleRequest(req, res);
    }).listen(8000, '127.0.0.1', () => console.error('incident-ops MCP on http://127.0.0.1:8000/mcp'));
  } else {
    await makeServer().connect(new StdioServerTransport());
  }
}

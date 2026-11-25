// Small release-desk MCP server with tiered risk (read, low risk write, hold, block) for exercising
// ArmorIQ policy. The data is canned and nothing is really deployed.
//
//   node src/releaseDeskMcp.js           stdio, the way an MCP host spawns it
//   node src/releaseDeskMcp.js --http    streamable HTTP on http://127.0.0.1:8000/mcp

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const BUILDS = {
  'checkout:512': { status: 'passed', commit: 'a41f9c2', tests: 1284, failed: 0 },
  // A flaky test, so the agent has a reason to rerun CI before it deploys.
  'payments:77': { status: 'failed', commit: '9be03d1', tests: 611, failed: 1, failing_test: 'test_refund_webhook_retry (flaky)' },
};
const ENVIRONMENTS = [
  { name: 'staging-us', owner: 'release-eng', idle_days: 0 },
  { name: 'staging-eu', owner: 'release-eng', idle_days: 41 },
];

const build = (service, buildId) => {
  const found = BUILDS[`${String(service).toLowerCase()}:${buildId}`];
  if (!found) throw new Error(`No build ${buildId} for service ${service}`);
  return { service, build_id: String(buildId), ...found };
};
const deploy = (a, environment) => {
  build(a.service, a.build_id); // unknown builds fail
  return { service: a.service, build_id: String(a.build_id), environment, status: 'deployed' };
};
const byBuild = { type: 'object', properties: { service: { type: 'string' }, build_id: { type: 'string' } }, required: ['service', 'build_id'] };

const TOOLS = [
  { name: 'list_environments', description: 'List the deploy environments and how long each has been idle.',
    inputSchema: { type: 'object', properties: {} }, run: () => ENVIRONMENTS },
  { name: 'get_build_status', description: 'Read the CI result for one build of a service.',
    inputSchema: byBuild, run: (a) => build(a.service, a.build_id) },
  { name: 'rerun_ci', description: 'Rerun CI for a build. Low risk: it only repeats the test run.',
    inputSchema: byBuild, run: (a) => ({ service: a.service, build_id: String(a.build_id), status: 'passed', rerun: true }) },
  { name: 'run_smoke_tests', description: 'Run the smoke test suite against a build. Takes a few seconds.',
    inputSchema: byBuild, run: async (a) => {
      build(a.service, a.build_id);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return { service: a.service, build_id: String(a.build_id), smoke: 'passed', checks: 12 };
    } },
  { name: 'deploy_to_staging', description: 'Deploy a build to the shared staging environment.',
    inputSchema: byBuild, run: (a) => deploy(a, 'staging-us') },
  { name: 'deploy_to_production', description: 'Deploy a build to production. Customer facing.',
    inputSchema: byBuild, run: (a) => deploy(a, 'production') },
  { name: 'request_teardown', description: 'File a teardown request for the platform team. Nothing is deleted until a human does it.',
    inputSchema: { type: 'object', properties: { environment: { type: 'string' }, reason: { type: 'string' } }, required: ['environment', 'reason'] },
    run: (a) => ({ ticket: 'OPS-4127', environment: a.environment, reason: a.reason, status: 'queued for platform team' }) },
  { name: 'delete_environment', description: 'Destroy an environment and its databases. Irreversible.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: (a) => ({ environment: a.name, status: 'destroyed' }) },
];

function makeServer() {
  const server = new Server({ name: 'release-desk', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = TOOLS.find((t) => t.name === params.name);
    try {
      if (!tool) throw new Error(`Unknown tool: ${params.name}`);
      const result = await tool.run(params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
    }).listen(8000, '127.0.0.1', () => console.error('release-desk MCP on http://127.0.0.1:8000/mcp'));
  } else {
    await makeServer().connect(new StdioServerTransport());
  }
}

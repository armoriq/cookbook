// On-call runbook tools over a small simulated fleet, tiered by risk.
//
//   get_service_status, read_recent_logs   read only            allow
//   restart_service                        changes production   hold
//   delete_volume                          destroys data        block
//
// The fleet is an in-memory object so the recipe runs anywhere. Swap each function body for your real
// calls (Kubernetes, your cloud API, your log store); the names and arguments are what the ArmorIQ
// policy matches on, so keep those stable.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const FLEET = {
  'checkout-api': {
    status: 'degraded',
    replicas: 3,
    healthy_replicas: 1,
    error_rate: '38% 502s over 10m',
    logs: [
      '12:01:07 ERROR upstream connect error: pool exhausted (max=50) to payments-db',
      '12:01:09 WARN  readiness probe failed on checkout-api-7c9f-2',
      '12:01:12 ERROR upstream connect error: pool exhausted (max=50) to payments-db',
      '12:01:15 INFO  config reload pushed pool_size=200, takes effect on restart',
    ],
  },
  'db-primary': {
    status: 'warning',
    replicas: 1,
    healthy_replicas: 1,
    disk: '94% used, volume db-primary-wal-archive is 61% of it',
    logs: ['12:00:44 WARN  disk usage above 90% on /var/lib/postgres'],
  },
};

function service(name) {
  if (!(name in FLEET)) throw new Error(`Unknown service: ${name}`);
  return FLEET[name];
}

const getServiceStatus = tool(
  async ({ service: name }) => {
    const { logs, ...rest } = service(name);
    return JSON.stringify({ ...rest, service: name });
  },
  {
    name: 'get_service_status',
    description: 'Current health of a service: status, replica counts, error rate, disk.',
    schema: z.object({ service: z.string() }),
  },
);

const readRecentLogs = tool(
  async ({ service: name, lines }) => JSON.stringify(service(name).logs.slice(-lines)),
  {
    name: 'read_recent_logs',
    description: 'The most recent log lines for a service.',
    schema: z.object({ service: z.string(), lines: z.number().default(20) }),
  },
);

const restartService = tool(
  async ({ service: name, reason }) => {
    const info = service(name);
    Object.assign(info, { status: 'healthy', healthy_replicas: info.replicas, error_rate: '0% 502s' });
    return JSON.stringify({ service: name, action: 'rolling_restart', reason, status: info.status });
  },
  {
    name: 'restart_service',
    description: 'Rolling restart of every replica of a service. Changes production.',
    schema: z.object({ service: z.string(), reason: z.string() }),
  },
);

const deleteVolume = tool(
  async ({ volume }) => JSON.stringify({ volume, status: 'deleted' }),
  {
    name: 'delete_volume',
    description: 'Permanently delete a storage volume and everything on it. Irreversible.',
    schema: z.object({ volume: z.string() }),
  },
);

export const TOOLS = [getServiceStatus, readRecentLogs, restartService, deleteVolume];
export const TOOLS_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// A small SQLite "warehouse" exposed as a stdio MCP server, with tools tiered by risk.
//
//   node src/sqlWarehouseMcp.js [--db path/to/analytics.db]
//
// The database is built from db/seed.sql the first time (or whenever the file is missing). It runs on
// sql.js (SQLite compiled to WebAssembly), so there is no native build. Tool names carry the risk on
// purpose, so an ArmorIQ policy can match each one by name:
//
//   list_tables, describe_table, run_select    read only            allow
//   insert_row, update_rows                    writes               hold
//   delete_rows, drop_table, export_table      destructive / exfil  block
//
// The server keeps its own guard rails too (query_only for run_select, identifier checks everywhere).
// ArmorIQ is the policy layer; it does not replace basic input hygiene.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import initSqlJs from 'sql.js';
import { z } from 'zod';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = resolve(HERE, '../db/seed.sql');
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const dbFlag = process.argv.indexOf('--db');
const DB_PATH = resolve(dbFlag > -1 ? process.argv[dbFlag + 1] : resolve(HERE, '../analytics.db'));

const SQL = await initSqlJs();
let db;
if (existsSync(DB_PATH)) {
  db = new SQL.Database(readFileSync(DB_PATH));
} else {
  db = new SQL.Database();
  db.exec(readFileSync(SEED, 'utf8'));
  save();
}

// sql.js keeps the database in memory, so write the file after every change.
function save() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function identifier(name) {
  if (!IDENTIFIER.test(name ?? '')) throw new Error(`Not a plain table or column name: ${JSON.stringify(name)}`);
  return name;
}

function rows(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    return out;
  } finally {
    stmt.free();
  }
}

function existingTable(table) {
  identifier(table);
  if (rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]).length === 0) {
    throw new Error(`No such table: ${table}`);
  }
  return table;
}

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const fail = (error) => ({ isError: true, content: [{ type: 'text', text: error.message }] });
const tool = (handler) => async (args) => {
  try {
    return text(handler(args));
  } catch (error) {
    return fail(error);
  }
};

const server = new McpServer({ name: 'sql-warehouse', version: '1.0.0' });
const cell = z.union([z.string(), z.number(), z.null()]);

server.registerTool('list_tables', { description: 'List the tables in the analytics database.' }, tool(() =>
  rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name)));

server.registerTool('describe_table', {
  description: "Show a table's columns and types.",
  inputSchema: { table: z.string() },
}, tool(({ table }) => rows(`PRAGMA table_info(${existingTable(table)})`).map((r) => ({ column: r.name, type: r.type }))));

server.registerTool('run_select', {
  description: 'Run one read only SELECT (or WITH ... SELECT) query and return up to 200 rows.',
  inputSchema: { sql: z.string() },
}, tool(({ sql }) => {
  const statement = sql.trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(statement) || statement.includes(';')) {
    throw new Error('run_select only runs a single SELECT statement');
  }
  db.run('PRAGMA query_only = ON');
  try {
    return rows(statement).slice(0, 200);
  } finally {
    db.run('PRAGMA query_only = OFF');
  }
}));

server.registerTool('insert_row', {
  description: 'Insert one row. `values` maps column name to value.',
  inputSchema: { table: z.string(), values: z.record(cell) },
}, tool(({ table, values }) => {
  existingTable(table);
  const columns = Object.keys(values).map(identifier);
  db.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, Object.values(values));
  const inserted = rows('SELECT last_insert_rowid() AS id')[0].id;
  save();
  return { table, inserted_rowid: inserted };
}));

server.registerTool('update_rows', {
  description: 'Set `values` on the rows where `key_column` equals `key_value`.',
  inputSchema: { table: z.string(), values: z.record(cell), key_column: z.string(), key_value: z.string() },
}, tool(({ table, values, key_column, key_value }) => {
  existingTable(table);
  const assignments = Object.keys(values).map((c) => `${identifier(c)} = ?`).join(', ');
  db.run(`UPDATE ${table} SET ${assignments} WHERE ${identifier(key_column)} = ?`, [...Object.values(values), key_value]);
  const updated = db.getRowsModified();
  save();
  return { table, rows_updated: updated };
}));

server.registerTool('delete_rows', {
  description: 'Delete the rows where `key_column` equals `key_value`. Irreversible.',
  inputSchema: { table: z.string(), key_column: z.string(), key_value: z.string() },
}, tool(({ table, key_column, key_value }) => {
  existingTable(table);
  db.run(`DELETE FROM ${table} WHERE ${identifier(key_column)} = ?`, [key_value]);
  const deleted = db.getRowsModified();
  save();
  return { table, rows_deleted: deleted };
}));

server.registerTool('drop_table', {
  description: 'Drop a whole table. Irreversible.',
  inputSchema: { table: z.string() },
}, tool(({ table }) => {
  db.run(`DROP TABLE ${existingTable(table)}`);
  save();
  return { table, status: 'dropped' };
}));

server.registerTool('export_table', {
  description: 'Export a whole table as CSV to a destination outside the warehouse.',
  inputSchema: { table: z.string(), destination: z.string() },
}, tool(({ table, destination }) => {
  const data = rows(`SELECT * FROM ${existingTable(table)}`);
  const quote = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v ?? ''));
  const csv = data.length
    ? [Object.keys(data[0]).join(','), ...data.map((r) => Object.values(r).map(quote).join(','))].join('\n')
    : '';
  // This demo server never sends anything anywhere; it only reports what it would export.
  return { table, destination, rows: data.length, bytes: Buffer.byteLength(csv) };
}));

await server.connect(new StdioServerTransport());

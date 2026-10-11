import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { registerTools } from '../index.js';
import { ToolRegistry, getToolRegistry } from '../registry.js';
import { ConnectorManager } from '../../connectors/manager.js';
import { setToolMode } from '../../utils/tool-handler-helpers.js';
import type { Connector } from '../../connectors/interface.js';
import type { TomlConfig } from '../../types/config.js';

vi.mock('../../connectors/manager.js');
vi.mock('../registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../registry.js')>()),
  getToolRegistry: vi.fn(),
}));

const SOURCES: Record<string, string | undefined> = { a: 'Alpha', b: 'Beta', c: undefined };

const config: TomlConfig = {
  sources: Object.keys(SOURCES).map((id) => ({ id, type: 'sqlite', description: SOURCES[id] })) as any,
  tools: [
    { name: 'execute_sql', source: 'a', readonly: true, max_rows: 10 },
    { name: 'execute_sql', source: 'b' },
    { name: 'search_objects', source: 'a' },
    { name: 'search_objects', source: 'b' },
    { name: 'search_objects', source: 'c' }, // search-only source
    { name: 'explain_sql', source: 'b' },
    { name: 'count_rows', source: 'a', description: 'Count rows', statement: 'SELECT COUNT(*) FROM t' },
  ] as any,
};

const connectors: Record<string, Connector> = {};
const makeConnector = (sourceId: string): Connector =>
  ({
    id: 'sqlite',
    getId: () => sourceId,
    executeSQL: vi.fn().mockResolvedValue({ resultSets: [{ rows: [], rowCount: 0 }] }),
  }) as any;

type Registered = { description: string; inputSchema: any; annotations: any; handler: (a: any, e: any) => Promise<any> };

/** Register all tools against a recording fake server and return them by name. */
function register(): Record<string, Registered> {
  const tools: Record<string, Registered> = {};
  registerTools({
    registerTool: (name: string, cfg: any, handler: any) => {
      tools[name] = { ...cfg, handler };
    },
  } as any);
  return tools;
}

const enumIds = (t: Registered): string[] => [...t.inputSchema.shape.source_id.options];

describe('unified tool mode', () => {
  beforeEach(() => {
    setToolMode('per-source');
    for (const id of Object.keys(SOURCES)) connectors[id] = makeConnector(id);
    vi.mocked(ConnectorManager.getAvailableSourceIds).mockReturnValue(Object.keys(SOURCES));
    vi.mocked(ConnectorManager.getSourceConfig).mockImplementation(
      (id?: string) => config.sources.find((s) => s.id === id) as any
    );
    vi.mocked(ConnectorManager.getCurrentConnector).mockImplementation((id?: string) => connectors[id!]);
    vi.mocked(getToolRegistry).mockReturnValue(new ToolRegistry(config));
  });

  afterEach(() => {
    delete process.env.DBHUB_TOOL_MODE;
    setToolMode('per-source');
    vi.clearAllMocks();
  });

  it('keeps one tool per source by default', () => {
    expect(Object.keys(register()).sort()).toEqual([
      'count_rows',
      'execute_sql_a',
      'execute_sql_b',
      'explain_sql_b',
      'search_objects_a',
      'search_objects_b',
      'search_objects_c',
    ]);
  });

  it('uses the startup-resolved mode, not the environment, when registering', () => {
    process.env.DBHUB_TOOL_MODE = 'bogus';
    expect(Object.keys(register())).toContain('execute_sql_a');
  });

  it('keeps the per-source tool definitions unchanged', () => {
    const tools = register();
    const view = (t: Registered) => ({
      description: t.description,
      annotations: t.annotations,
      inputSchema: z.toJSONSchema(t.inputSchema),
    });
    expect(view(tools.execute_sql_a)).toMatchInlineSnapshot(`
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": false,
          "openWorldHint": false,
          "readOnlyHint": true,
          "title": "Execute SQL on a (sqlite)",
        },
        "description": "Alpha. Execute SQL queries on the 'a' sqlite database [READ-ONLY MODE] (limited to 10 rows; capped results carry "truncated": true)",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "sql": {
              "description": "SQL to execute (multiple statements separated by ;)",
              "type": "string",
            },
          },
          "required": [
            "sql",
          ],
          "type": "object",
        },
      }
    `);
    expect(view(tools.search_objects_a)).toMatchInlineSnapshot(`
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": false,
          "readOnlyHint": true,
          "title": "Search Database Objects on a (sqlite)",
        },
        "description": "Alpha. Search and list database objects on the 'a' sqlite database",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "detail_level": {
              "default": "names",
              "description": "Detail: names (minimal), summary (metadata), full (all)",
              "enum": [
                "names",
                "summary",
                "full",
              ],
              "type": "string",
            },
            "limit": {
              "default": 100,
              "description": "Max results",
              "exclusiveMinimum": 0,
              "maximum": 1000,
              "type": "integer",
            },
            "object_type": {
              "description": "Object type to search",
              "enum": [
                "schema",
                "table",
                "view",
                "column",
                "procedure",
                "function",
                "index",
              ],
              "type": "string",
            },
            "pattern": {
              "default": "%",
              "description": "LIKE pattern (% = any chars, _ = one char)",
              "type": "string",
            },
            "schema": {
              "description": "Filter to schema",
              "type": "string",
            },
            "table": {
              "description": "Filter to table (requires schema; column/index only)",
              "type": "string",
            },
          },
          "required": [
            "object_type",
            "pattern",
            "detail_level",
            "limit",
          ],
          "type": "object",
        },
      }
    `);
  });

  describe('when enabled', () => {
    beforeEach(() => {
      setToolMode('unified');
    });

    it('registers one tool per built-in kind and keeps custom tool names', () => {
      expect(Object.keys(register()).sort()).toEqual([
        'count_rows',
        'execute_sql',
        'explain_sql',
        'search_objects',
      ]);
    });

    it('limits the source_id enum to sources that enable the tool', () => {
      const tools = register();
      expect(enumIds(tools.execute_sql)).toEqual(['a', 'b']);
      expect(enumIds(tools.search_objects)).toEqual(['a', 'b', 'c']);
      expect(enumIds(tools.explain_sql)).toEqual(['b']);
    });

    it('requires source_id, rejects ids outside the enum, and keeps the original parameters', () => {
      const schema = register().execute_sql.inputSchema;
      expect(schema.safeParse({ sql: 'SELECT 1' }).success).toBe(false);
      expect(schema.safeParse({ source_id: 'c', sql: 'SELECT 1' }).success).toBe(false);
      expect(schema.safeParse({ source_id: 'a', sql: 'SELECT 1' }).success).toBe(true);
    });

    it('lists each source with its description, read-only flag and row cap', () => {
      const { description } = register().execute_sql;
      expect(description).toContain('- a (sqlite): Alpha. [READ-ONLY] (max 10 rows)');
      expect(description).toContain('- b (sqlite): Beta.');
      expect(description).not.toContain('- c ');
      expect(register().search_objects.description).toContain('- c (sqlite)');
    });

    it('applies each source readonly setting through the shared tool', async () => {
      const { handler } = register().execute_sql;

      const denied = await handler({ source_id: 'a', sql: 'DELETE FROM t' }, null);
      expect(denied.isError).toBe(true);
      expect(JSON.parse(denied.content[0].text).code).toBe('READONLY_VIOLATION');
      expect(connectors.a.executeSQL).not.toHaveBeenCalled();

      const allowed = await handler({ source_id: 'b', sql: 'DELETE FROM t' }, null);
      expect(allowed.isError).toBeFalsy();
      expect(connectors.b.executeSQL).toHaveBeenCalledTimes(1);
    });

    it('sets readOnlyHint only when every listed source is read-only', () => {
      expect(register().execute_sql.annotations.readOnlyHint).toBe(false);

      vi.mocked(getToolRegistry).mockReturnValue(
        new ToolRegistry({
          ...config,
          tools: config.tools!.map((t) => (t.name === 'execute_sql' ? { ...t, readonly: true } : t)),
        })
      );
      expect(register().execute_sql.annotations.readOnlyHint).toBe(true);
    });

    it('does not register a built-in no source enables', () => {
      vi.mocked(getToolRegistry).mockReturnValue(
        new ToolRegistry({ ...config, tools: config.tools!.filter((t) => t.name !== 'explain_sql') })
      );
      expect(Object.keys(register())).not.toContain('explain_sql');
    });
  });
});

import { z } from 'zod';

export const scriptSummary = z.object({
  id: z.number().int(),
  name: z.string(),
  namespace: z.string().optional(),
  version: z.string().optional(),
  enabled: z.boolean(),
  matches: z.array(z.string()),
});

export const scriptDetail = scriptSummary.extend({
  code: z.string(),
});

export const tabSummary = z.object({
  tabId: z.number().int(),
  url: z.string(),
  title: z.string(),
});

export const tabScript = z.object({
  id: z.number().int(),
  name: z.string(),
  version: z.string().optional(),
  runAt: z.string().describe('Value of @run-at, e.g. "document-start"'),
  frameId: z.number().int(),
  status: z.enum(['injected', 'failed', 'pending']),
  error: z.string().optional().describe('Present when status is "failed"'),
  codeHash: z.string().optional().describe('Identifies the injected source'),
});

export const logEntry = z.object({
  seq: z.number().int(),
  time: z.number().int().describe('Milliseconds since the epoch'),
  scriptId: z.number().int(),
  text: z.string(),
  truncated: z.boolean().optional(),
  count: z.number().int().optional().describe('Number of identical consecutive lines collapsed'),
});

const executionScriptId = z.number().int().positive();
const executionTabId = z.number().int().nonnegative();
const frameId = z.number().int().nonnegative();
const callId = z.string().min(1).max(128);

const handlerName = z.string().regex(/^[\w.-]{1,64}$/).describe('Handler name from script_handlers');

const executionEntry = {
  scriptId: executionScriptId,
  frameId,
  documentId: z.string().describe('Opaque identity of the document the script ran in'),
  seq: z.number().int().nonnegative(),
  value: z.json().optional(),
  error: z.string().optional(),
};

export const scriptCall = z.object({
  kind: z.literal('call'),
  callId,
  handler: handlerName,
  ...executionEntry,
  status: z.enum(['pending', 'completed', 'failed', 'timed_out', 'cancelled']),
  startedAt: z.number().describe('Milliseconds since the epoch'),
  finishedAt: z.number().optional(),
});

export const scriptReport = z.object({
  kind: z.literal('report'),
  callId: callId.optional().describe('The call this report belongs to, if any'),
  ...executionEntry,
  reportedAt: z.number().describe('Milliseconds since the epoch'),
});

export const scriptResultEntry = z.discriminatedUnion('kind', [scriptCall, scriptReport]);

export const scriptHandler = z.object({
  name: handlerName,
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.json()).optional()
    .describe('JSON Schema provided by the script as a hint; it is not validated by the extension'),
});

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition<I extends z.ZodObject, O extends z.ZodObject> {
  title: string;
  description: string;
  input: I;
  output: O;
  annotations: ToolAnnotations;
}

function defineTool<I extends z.ZodObject, O extends z.ZodObject>(
  tool: ToolDefinition<I, O>,
) {
  return tool;
}

const scriptId = z.number().int().describe('Script id as returned by scripts_list');
const tabId = z.number().int().describe('Tab id as returned by tabs_list');

export const tools = {
  scripts_list: defineTool({
    title: 'List scripts',
    description: 'List installed userscripts, optionally filtered by a name substring.',
    input: z.object({
      query: z.string().optional().describe('Case-insensitive name filter'),
    }),
    output: z.object({ scripts: z.array(scriptSummary) }),
    annotations: { readOnlyHint: true },
  }),
  scripts_get: defineTool({
    title: 'Get script',
    description: 'Get a userscript with its metadata and full source code.',
    input: z.object({ id: scriptId }),
    output: z.object({ script: scriptDetail }),
    annotations: { readOnlyHint: true },
  }),
  scripts_write: defineTool({
    title: 'Write script',
    description:
      'Create or update a userscript from source code. The code must include a ==UserScript== metadata block. ' +
      'With `id`, that script is updated. Without `id`, a script with the same @name and @namespace is updated, otherwise a new script is created.',
    input: z.object({
      code: z.string().min(1),
      id: scriptId.optional(),
      enabled: z.boolean().optional().describe('Defaults to the current state, or true for new scripts'),
    }),
    output: z.object({
      script: scriptSummary,
      created: z.boolean().describe('Whether a new script was created'),
    }),
    annotations: { idempotentHint: true },
  }),
  scripts_set_enabled: defineTool({
    title: 'Enable or disable script',
    description: 'Enable or disable a userscript.',
    input: z.object({ id: scriptId, enabled: z.boolean() }),
    output: z.object({ script: scriptSummary }),
    annotations: { idempotentHint: true },
  }),
  scripts_delete: defineTool({
    title: 'Delete script',
    description: 'Permanently remove a userscript.',
    input: z.object({ id: scriptId }),
    output: z.object({ id: z.number().int() }),
    annotations: { destructiveHint: true },
  }),
  tabs_list: defineTool({
    title: 'List granted tabs',
    description:
      'List the browser tabs the user has granted to the agent. Empty until the user grants a tab in Violentmonkey; ' +
      'when empty, call vm_status and give the user the URL it returns.',
    input: z.object({}),
    output: z.object({ tabs: z.array(tabSummary) }),
    annotations: { readOnlyHint: true },
  }),
  tab_scripts: defineTool({
    title: 'List scripts injected in a tab',
    description:
      'Report what Violentmonkey attempted to run on a granted tab, including scripts that failed to inject. ' +
      'A script missing from the list did not run; use scripts_list and scripts_test_match to find out why.',
    input: z.object({ tabId }),
    output: z.object({
      url: z.string(),
      loadId: z.string().describe('Identifies the document these results came from'),
      scripts: z.array(tabScript),
    }),
    annotations: { readOnlyHint: true },
  }),
  tab_reload: defineTool({
    title: 'Reload tab',
    description:
      'Reload a granted tab so Violentmonkey re-injects its scripts. Returns the new loadId, ' +
      'which can be passed to script_logs as sinceLoadId.',
    input: z.object({ tabId }),
    output: z.object({
      tabId: z.number().int(),
      url: z.string(),
      loadId: z.string(),
    }),
    annotations: { idempotentHint: true },
  }),
  script_logs: defineTool({
    title: 'Read script logs',
    description:
      'Read what a userscript logged with GM_log on a granted tab. The script must declare @grant GM_log. ' +
      'Logs are captured only while Violentmonkey is connected. Poll with afterSeq, or pass sinceLoadId to read one document.',
    input: z.object({
      tabId,
      scriptId: scriptId.optional(),
      afterSeq: z.number().int().optional().describe('Return entries with seq greater than this'),
      sinceLoadId: z.string().optional().describe('Only entries from this document load'),
      limit: z.number().int().min(1).max(500).optional().describe('Default 200, max 500'),
    }),
    output: z.object({
      entries: z.array(logEntry),
      nextSeq: z.number().int().describe('Pass as afterSeq to poll for newer entries'),
      dropped: z.number().int().describe('Entries evicted from the buffer since the last call'),
    }),
    annotations: { readOnlyHint: true },
  }),
  script_handlers: defineTool({
    title: 'List callable script handlers',
    description:
      'List named handlers that userscripts registered with GM.mcp.register in a granted tab, per script and frame, ' +
      'with their descriptions and input schemas. The script must declare @grant GM.mcp or GM_mcp. Grant and reload the tab first.',
    input: z.object({ tabId: executionTabId }),
    output: z.object({
      scripts: z.array(z.object({ scriptId: executionScriptId, frameId, handlers: z.array(scriptHandler) })),
    }),
    annotations: { readOnlyHint: true },
  }),
  script_call: defineTool({
    title: 'Call a userscript handler',
    description:
      'Invoke a named userscript handler in a granted tab with JSON params. It may have side effects. ' +
      'The handler validates params itself; inputSchema is only a hint. ' +
      'Inspect result.status for script success or failure. wait=false returns immediately; poll script_results afterwards. ' +
      'The handler may add reports to the call, also after it settled; read them with script_results and the callId. ' +
      'A timeout does not stop execution. Reusing a retained callId with the same script, frame, handler and params does not execute again; ' +
      'deduplication ends when the result is evicted or the session ends. Do not automatically retry side effects with a new callId.',
    input: z.object({
      tabId: executionTabId,
      scriptId: executionScriptId,
      frameId: frameId.default(0),
      handler: handlerName,
      params: z.json().default(null),
      callId: callId.optional(),
      wait: z.boolean().default(true),
      timeoutMs: z.number().int().min(1).max(25000).default(10000),
    }),
    output: z.object({ result: scriptCall }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }),
  script_results: defineTool({
    title: 'Read script results',
    description:
      'Read retained calls and reports in a granted tab, ordered by seq. Reports come from GM.mcp.report or a handler\'s ' +
      'call-bound report and carry the callId of their call, if any. Filter by callId (the call and its reports) or scriptId, ' +
      'or poll with afterSeq. Results are held in memory for up to five minutes with entry and size limits; dropped is cumulative. ' +
      'Revocation, tab close or disconnect clears them. Reading does not consume results.',
    input: z.object({
      tabId: executionTabId,
      scriptId: executionScriptId.optional(),
      callId: callId.optional(),
      afterSeq: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    output: z.object({
      entries: z.array(scriptResultEntry),
      nextSeq: z.number().int().nonnegative(),
      dropped: z.number().int().nonnegative(),
    }),
    annotations: { readOnlyHint: true },
  }),
  scripts_test_match: defineTool({
    title: 'Test script match',
    description:
      'Ask whether a userscript would be injected at a URL, using the same matcher Violentmonkey uses. ' +
      'Takes full source rather than an id, so it works before the script is installed.',
    input: z.object({
      code: z
        .string()
        .min(1)
        .describe('Userscript source, including the ==UserScript== metadata block'),
      url: z.string().describe('Full page URL, including any query string or fragment'),
    }),
    output: z.object({
      matched: z.boolean(),
      rule: z
        .string()
        .optional()
        .describe('The @match/@include/@exclude pattern that decided the result'),
      tried: z.array(z.string()).describe('Every URL rule evaluated, in order'),
    }),
    annotations: { readOnlyHint: true },
  }),
} as const;

export type Tools = typeof tools;
export type ToolName = keyof Tools;
export type ToolInput<N extends ToolName> = z.infer<Tools[N]['input']>;
export type ToolOutput<N extends ToolName> = z.infer<Tools[N]['output']>;

export const toolNames = Object.keys(tools) as ToolName[];

export function isReadOnlyTool(name: ToolName) {
  return tools[name].annotations.readOnlyHint === true;
}

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(tools, name);
}

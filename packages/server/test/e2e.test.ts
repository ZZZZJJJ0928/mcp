import { request } from 'node:http';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createClient, ToolCallError, type McpClient } from '@violentmonkey/mcp-client';
import type { ToolOutput } from '@violentmonkey/mcp-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../src/index';

const TOKEN = 'test-token';

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const summary = { id: 1, name: 'demo', enabled: true, matches: ['*://example.com/*'] };

describe('violentmonkey mcp', () => {
  let port: number;
  let server: RunningServer;
  let mcp: Client;
  const extensions: McpClient[] = [];

  function extension(token = TOKEN) {
    const ext = createClient({ port, token, info: { name: 'test', version: '1' } });
    extensions.push(ext);
    return ext;
  }

  beforeEach(async () => {
    port = await freePort();
    server = await startServer({
      port,
      token: TOKEN,
      transport: 'http',
      allowNoOrigin: true,
      callTimeoutMs: 500,
    });
    mcp = new Client({ name: 'agent', version: '1' });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
  });

  afterEach(async () => {
    for (const ext of extensions.splice(0)) ext.close();
    await mcp.close();
    await server.close();
  });

  it('reports disconnected status and exposes only vm_status', async () => {
    const status = await mcp.callTool({ name: 'vm_status', arguments: {} });
    expect(status.structuredContent).toMatchObject({ connected: false });

    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['vm_status']);

    await expect(mcp.callTool({ name: 'scripts_list', arguments: {} })).resolves.toMatchObject({
      isError: true,
    });
  });

  it('forwards tool calls to the extension', async () => {
    const ext = extension();
    ext.handle('scripts_list', ({ query }) => ({
      scripts: query === 'none' ? [] : [summary],
    }));
    ext.connect();
    await waitFor(() => ext.status === 'open');

    const status = await mcp.callTool({ name: 'vm_status', arguments: {} });
    expect(status.structuredContent).toMatchObject({
      connected: true,
      tools: ['scripts_list'],
    });

    const res = await mcp.callTool({ name: 'scripts_list', arguments: {} });
    expect(res.structuredContent).toEqual({ scripts: [summary] });
  });

  it('forwards scripts_write and returns whether the script was created', async () => {
    const ext = extension();
    ext.handle('scripts_write', ({ id }) => ({ script: { ...summary, id: id ?? 7 }, created: id === undefined }));
    ext.connect();
    await waitFor(() => ext.status === 'open');

    const code = '// ==UserScript==\n// @name demo\n// ==/UserScript==';
    const created = await mcp.callTool({ name: 'scripts_write', arguments: { code } });
    expect(created.structuredContent).toMatchObject({ created: true, script: { id: 7 } });
    const updated = await mcp.callTool({ name: 'scripts_write', arguments: { code, id: 1 } });
    expect(updated.structuredContent).toMatchObject({ created: false, script: { id: 1 } });
  });

  it('only lists tools supported by the extension while connected', async () => {
    const ext = extension();
    ext.handle('scripts_list', () => ({ scripts: [] }));
    ext.connect();
    await waitFor(() => ext.status === 'open');
    const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['scripts_list', 'vm_status']);
  });

  it('exposes the development tools when the extension supports them', async () => {
    const ext = extension();
    ext.handle('tabs_list', () => ({
      tabs: [{ tabId: 5, url: 'https://example.com/', title: 'Example' }],
    }));
    ext.handle('tab_scripts', () => ({
      url: 'https://example.com/',
      loadId: 'load-1',
      scripts: [
        {
          id: 3,
          name: 'demo',
          runAt: 'document-end',
          frameId: 0,
          status: 'injected' as const,
          codeHash: 'abc',
        },
        {
          id: 4,
          name: 'broken',
          runAt: 'document-start',
          frameId: 0,
          status: 'failed' as const,
          error: 'SyntaxError: unexpected token',
        },
      ],
    }));
    ext.handle('tab_reload', () => ({
      tabId: 5,
      url: 'https://example.com/',
      loadId: 'load-2',
    }));
    ext.handle('script_logs', ({ afterSeq }) => ({
      entries: [
        { seq: (afterSeq ?? 0) + 1, time: 1, scriptId: 3, text: 'hello' },
        { seq: (afterSeq ?? 0) + 2, time: 2, scriptId: 3, text: 'hello', count: 4 },
      ],
      nextSeq: (afterSeq ?? 0) + 2,
      dropped: 0,
    }));
    ext.handle('scripts_test_match', ({ url }) => ({
      matched: url.startsWith('https://example.com/'),
      rule: '@match https://example.com/*',
      tried: ['@match https://example.com/*'],
    }));
    ext.connect();
    await waitFor(() => ext.status === 'open');

    const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'script_logs',
      'scripts_test_match',
      'tab_reload',
      'tab_scripts',
      'tabs_list',
      'vm_status',
    ]);

    const tabs = await mcp.callTool({ name: 'tabs_list', arguments: {} });
    expect(tabs.structuredContent).toEqual({
      tabs: [{ tabId: 5, url: 'https://example.com/', title: 'Example' }],
    });

    const injected = await mcp.callTool({ name: 'tab_scripts', arguments: { tabId: 5 } });
    expect(injected.structuredContent).toMatchObject({
      loadId: 'load-1',
      scripts: [
        { id: 3, status: 'injected' },
        { id: 4, status: 'failed', error: 'SyntaxError: unexpected token' },
      ],
    });

    const reloaded = await mcp.callTool({ name: 'tab_reload', arguments: { tabId: 5 } });
    expect(reloaded.structuredContent).toMatchObject({ loadId: 'load-2' });

    const logs = await mcp.callTool({
      name: 'script_logs',
      arguments: { tabId: 5, sinceLoadId: 'load-2' },
    });
    expect(logs.structuredContent).toMatchObject({ nextSeq: 2, dropped: 0 });

    const matched = await mcp.callTool({
      name: 'scripts_test_match',
      arguments: { code: '// ==UserScript==\n// @name demo\n// ==/UserScript==', url: 'https://example.com/' },
    });
    expect(matched.structuredContent).toMatchObject({ matched: true });
  });

  it('rejects script_logs limits above the cap', async () => {
    const ext = extension();
    ext.handle('script_logs', () => ({ entries: [], nextSeq: 0, dropped: 0 }));
    ext.connect();
    await waitFor(() => ext.status === 'open');
    const res = await mcp.callTool({
      name: 'script_logs',
      arguments: { tabId: 1, limit: 1000 },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('500');
  });

  it('discovers named handlers and preserves correlated calls and reports', async () => {
    const ext = extension();
    const records: Array<ToolOutput<'script_results'>['entries'][number]> = [];
    const inputs: unknown[] = [];
    const scripts = [{
      scriptId: 1,
      frameId: 0,
      handlers: [
        { name: 'echo', description: 'Echoes params', inputSchema: { type: 'object' } },
        { name: 'ping' },
      ],
    }];
    ext.handle('script_handlers', () => ({ scripts }));
    ext.handle('script_call', async (input) => {
      inputs.push(input);
      // Complete concurrent requests in the opposite order to their dispatch.
      if (input.callId === 'first') await new Promise(resolve => setTimeout(resolve, 30));
      const result = {
        kind: 'call' as const, callId: input.callId!, handler: input.handler,
        scriptId: input.scriptId, frameId: input.frameId, documentId: 'document-one', seq: records.length + 1,
        status: 'completed' as const, startedAt: 1, finishedAt: 2, value: input.params,
      };
      records.push(result);
      records.push({
        kind: 'report', callId: input.callId!, scriptId: input.scriptId, frameId: input.frameId,
        documentId: 'document-one', seq: records.length + 1, reportedAt: 3, value: { progress: 1 },
      });
      return { result };
    });
    ext.handle('script_results', ({ callId, afterSeq, limit }) => {
      const entries = records.filter(r => (!callId || r.callId === callId) && r.seq > afterSeq).slice(0, limit);
      return { entries, nextSeq: entries.at(-1)?.seq ?? afterSeq, dropped: 0 };
    });
    ext.connect();
    await waitFor(() => ext.status === 'open');
    expect((await mcp.listTools()).tools.map(t => t.name).sort()).toEqual([
      'script_call', 'script_handlers', 'script_results', 'vm_status',
    ]);
    expect((await mcp.callTool({ name: 'script_handlers', arguments: { tabId: 7 } })).structuredContent)
      .toEqual({ scripts });

    const values = [{ rows: [false, 0, '', null] }, false];
    const responses = await Promise.all(['first', 'second'].map((callId, i) => mcp.callTool({
      name: 'script_call', arguments: { tabId: 7, scriptId: 1, handler: 'echo', callId, params: values[i] },
    })));
    expect(responses[0]?.structuredContent).toMatchObject({ result: { kind: 'call', callId: 'first', value: values[0] } });
    expect(responses[1]?.structuredContent).toMatchObject({ result: { callId: 'second', handler: 'echo', value: false } });
    expect(inputs[0]).toEqual({
      tabId: 7, scriptId: 1, handler: 'echo', callId: 'first', frameId: 0, params: values[0], wait: true, timeoutMs: 10000,
    });
    const page = await mcp.callTool({ name: 'script_results', arguments: { tabId: 7, limit: 2 } });
    expect(page.structuredContent).toEqual({ entries: records.slice(0, 2), nextSeq: 2, dropped: 0 });
    const next = await mcp.callTool({ name: 'script_results', arguments: { tabId: 7, afterSeq: 2 } });
    expect(next.structuredContent).toEqual({ entries: records.slice(2), nextSeq: 4, dropped: 0 });
    const unsolicited = { kind: 'report' as const, scriptId: 1, frameId: 0, documentId: 'd', seq: 5, reportedAt: 4, value: 'ready' };
    records.push(unsolicited);
    expect((await mcp.callTool({ name: 'script_results', arguments: { tabId: 7, afterSeq: 4 } })).structuredContent)
      .toEqual({ entries: [unsolicited], nextSeq: 5, dropped: 0 });
  });

  it.each(['pending', 'failed', 'timed_out', 'cancelled'] as const)(
    'returns an execution status of %s as structured data, not a transport error', async status => {
      const ext = extension();
      ext.handle('script_call', ({ scriptId, frameId, handler }) => ({ result: {
        kind: 'call', callId: 'call-one', handler, scriptId, frameId, documentId: 'doc', seq: 1,
        status, startedAt: 1, ...(status !== 'pending' && { finishedAt: 2, error: 'Script did not complete' }),
      } }));
      ext.connect();
      await waitFor(() => ext.status === 'open');
      const result = await mcp.callTool({
        name: 'script_call', arguments: { tabId: 7, scriptId: 1, handler: 'echo', wait: false },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ result: { status } });
    },
  );

  it('validates execution arguments before dispatch and preserves authorization errors', async () => {
    const ext = extension();
    const invoke = vi.fn(() => { throw new ToolCallError(403, 'Tab is not authorized for MCP'); });
    ext.handle('script_call', invoke);
    ext.connect();
    await waitFor(() => ext.status === 'open');
    for (const invalid of [
      { timeoutMs: 25001 }, { timeoutMs: 0 }, { scriptId: 0 }, { frameId: -1 },
      { callId: '' }, { callId: 'x'.repeat(129) }, { wait: 'yes' },
      { handler: undefined }, { handler: '' }, { handler: 'has space' }, { handler: 'x'.repeat(65) },
    ]) {
      const result = await mcp.callTool({
        name: 'script_call', arguments: { tabId: 7, scriptId: 1, handler: 'echo', ...invalid },
      });
      expect(result.isError).toBe(true);
    }
    expect(invoke).not.toHaveBeenCalled();
    const denied = await mcp.callTool({ name: 'script_call', arguments: { tabId: 7, scriptId: 1, handler: 'echo' } });
    expect(denied).toMatchObject({ isError: true, content: [{ type: 'text', text: '[403] Tab is not authorized for MCP' }] });
  });

  it.each([
    ['script_call', { result: { status: 'unknown' } }],
    ['script_call', { result: { kind: 'report', scriptId: 1, frameId: 0, documentId: 'd', seq: 1, reportedAt: 1 } }],
    ['script_results', { entries: [{ kind: 'other' }], nextSeq: 0, dropped: 0 }],
    ['script_handlers', { scripts: [{ scriptId: 1, frameId: 0, handlers: [{ name: 'bad name' }] }] }],
  ] as const)('rejects malformed %s output from an extension', async (name, output) => {
    const ext = extension();
    ext.handle(name, () => output as never);
    ext.connect();
    await waitFor(() => ext.status === 'open');
    const result = await mcp.callTool({ name, arguments: { tabId: 7, scriptId: 1, handler: 'echo' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('[502]');
  });

  it('propagates handler errors and validates params', async () => {
    const ext = extension();
    ext.handle('scripts_get', () => {
      throw new ToolCallError(404, 'Script 9 not found');
    });
    ext.connect();
    await waitFor(() => ext.status === 'open');

    const res = await mcp.callTool({ name: 'scripts_get', arguments: { id: 9 } });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: 'text', text: '[404] Script 9 not found' }]);
  });

  it('returns 502 when the extension violates the output schema', async () => {
    const ext = extension();
    ext.handle('scripts_list', () => ({ scripts: 'nope' }) as never);
    ext.connect();
    await waitFor(() => ext.status === 'open');
    const res = await mcp.callTool({ name: 'scripts_list', arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('[502]');
  });

  it('times out with 504', async () => {
    const ext = extension();
    ext.handle('scripts_list', () => new Promise(() => {}));
    ext.connect();
    await waitFor(() => ext.status === 'open');
    const res = await mcp.callTool({ name: 'scripts_list', arguments: {} });
    expect(JSON.stringify(res.content)).toContain('[504]');
  });

  it('returns 503 when the extension disconnects mid-call', async () => {
    const ext = extension();
    ext.handle('scripts_list', () => new Promise(() => {}));
    ext.connect();
    await waitFor(() => ext.status === 'open');
    const call = mcp.callTool({ name: 'scripts_list', arguments: {} });
    await new Promise((r) => setTimeout(r, 50));
    ext.close();
    const res = await call;
    expect(JSON.stringify(res.content)).toContain('[503]');
  });

  it('replaces the existing connection when a new one authenticates', async () => {
    const first = extension();
    first.handle('scripts_list', () => ({ scripts: [] }));
    first.connect();
    await waitFor(() => first.status === 'open');

    const second = extension();
    second.handle('scripts_list', () => ({ scripts: [summary] }));
    second.connect();
    await waitFor(() => second.status === 'open');
    await waitFor(() => first.status === 'closed');
    expect(first.closeCode).toBe(4001);

    const res = await mcp.callTool({ name: 'scripts_list', arguments: {} });
    expect(res.structuredContent).toEqual({ scripts: [summary] });
  });

  it('rejects a bad token without affecting the active connection', async () => {
    const good = extension();
    good.handle('scripts_list', () => ({ scripts: [] }));
    good.connect();
    await waitFor(() => good.status === 'open');

    const bad = extension('wrong');
    bad.connect();
    await waitFor(() => bad.status === 'closed');
    expect(bad.closeCode).toBe(4003);
    expect(good.status).toBe('open');
  });

  it('requires a bearer token on /mcp', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/health', headers: { Host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.once('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
  });
});

describe('origin check', () => {
  it('rejects websocket upgrades without an extension origin', async () => {
    const port = await freePort();
    const server = await startServer({ port, token: TOKEN, transport: 'http' });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ws`, {
        headers: { Origin: 'https://evil.example' },
      });
      expect(res.status).toBe(403);
    } finally {
      await server.close();
    }
  });
});

describe('read-only mode', () => {
  it('allows execution discovery and results but never forwards script_call', async () => {
    const port = await freePort();
    const server = await startServer({ port, token: TOKEN, transport: 'http', allowNoOrigin: true, readonly: true });
    const mcp = new Client({ name: 'agent', version: '1' });
    const ext = createClient({ port, token: TOKEN, info: { name: 'test', version: '1' } });
    const invoke = vi.fn(() => { throw new Error('Must never be called'); });
    ext.handle('script_call', invoke);
    ext.handle('script_handlers', () => ({ scripts: [{ scriptId: 1, frameId: 0, handlers: [{ name: 'echo' }] }] }));
    ext.handle('script_results', () => ({ entries: [], nextSeq: 0, dropped: 0 }));
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }));
      ext.connect();
      await waitFor(() => ext.status === 'open');
      expect((await mcp.listTools()).tools.map(t => t.name).sort())
        .toEqual(['script_handlers', 'script_results', 'vm_status']);
      expect((await mcp.callTool({ name: 'script_results', arguments: { tabId: 7 } })).structuredContent)
        .toEqual({ entries: [], nextSeq: 0, dropped: 0 });
      expect((await mcp.callTool({
        name: 'script_call', arguments: { tabId: 7, scriptId: 1, handler: 'echo' },
      })).isError).toBe(true);
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      ext.close();
      await mcp.close();
      await server.close();
    }
  });

  it('hides write tools and never forwards them', async () => {
    const port = await freePort();
    const server = await startServer({
      port,
      token: TOKEN,
      transport: 'http',
      allowNoOrigin: true,
      readonly: true,
    });
    const mcp = new Client({ name: 'agent', version: '1' });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const ext = createClient({ port, token: TOKEN, info: { name: 'test', version: '1' } });
    ext.handle('scripts_list', () => ({ scripts: [] }));
    ext.handle('scripts_delete', ({ id }) => ({ id }));
    ext.handle('scripts_write', () => ({ script: summary, created: false }));
    try {
      const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(['vm_status']);

      ext.connect();
      await waitFor(() => ext.status === 'open');
      const status = await mcp.callTool({ name: 'vm_status', arguments: {} });
      expect(status.structuredContent).toMatchObject({
        readonly: true,
        tools: ['scripts_list'],
      });
      const res = await mcp.callTool({ name: 'scripts_delete', arguments: { id: 1 } });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('not found');
    } finally {
      ext.close();
      await mcp.close();
      await server.close();
    }
  });

  it('hides tab_reload but keeps the read-only development tools', async () => {
    const port = await freePort();
    const server = await startServer({
      port,
      token: TOKEN,
      transport: 'http',
      allowNoOrigin: true,
      readonly: true,
    });
    const mcp = new Client({ name: 'agent', version: '1' });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const ext = createClient({ port, token: TOKEN, info: { name: 'test', version: '1' } });
    ext.handle('tabs_list', () => ({ tabs: [] }));
    ext.handle('tab_scripts', () => ({ url: '', loadId: 'l', scripts: [] }));
    ext.handle('tab_reload', () => ({ tabId: 1, url: '', loadId: 'l' }));
    try {
      ext.connect();
      await waitFor(() => ext.status === 'open');
      const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(['tab_scripts', 'tabs_list', 'vm_status']);
    } finally {
      ext.close();
      await mcp.close();
      await server.close();
    }
  });
});

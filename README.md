# Violentmonkey MCP

Let AI agents (Claude, etc.) manage your [Violentmonkey](https://violentmonkey.github.io/) userscripts through the [Model Context Protocol](https://modelcontextprotocol.io/).

Violentmonkey runs inside the browser and cannot listen on a port, so a small local server bridges the two sides:

```
┌────────┐  MCP (stdio or HTTP)  ┌──────────────────┐   WebSocket   ┌───────────────┐
│ Agent  │ ────────────────────► │ @violentmonkey/  │ ◄──────────── │ Violentmonkey │
│(Claude)│ ◄──────────────────── │ mcp  (server)    │ ──────────►   │  (extension)  │
└────────┘                       └──────────────────┘  tool calls   └───────────────┘
```

- The **agent** speaks MCP to the server.
- The **extension** connects to the server over a WebSocket, authenticated with a one-time token.
- The server owns the list of tools and their schemas. Agent tool calls are forwarded to the extension and the results are returned.

## Prerequisites

- Violentmonkey >= 2.49.5, which added MCP support. Per-tool minimums are listed under [Tools](#tools).
- Node.js >= 24

## Usage

### 1. Add the server to your agent

Claude Code:

```sh
claude mcp add violentmonkey -- npx -y @violentmonkey/mcp -p 5678
```

Claude Desktop / any stdio-based client (`mcpServers` config):

```json
{
  "mcpServers": {
    "violentmonkey": {
      "command": "npx",
      "args": ["-y", "@violentmonkey/mcp", "-p", "5678"]
    }
  }
}
```

### 2. Connect Violentmonkey

Ask the agent to call `vm_status`. It returns a connect URL such as:

```
https://violentmonkey.github.io/mcp_connect.html?port=5678&token=<generated_token>
```

Open it in the browser. Violentmonkey intercepts the URL and shows an authorization page; after you approve, the extension connects to the server and the tools become usable.

The same URL is also printed to stderr when the server starts.

### 3. Use it

> "List my userscripts", "Create a script that hides the sidebar on example.com", "Fix the bug in my GitHub script".

## CLI

```
npx @violentmonkey/mcp [options]

  -p, --port <number>        Port for the extension (and HTTP transport). Default: 5678
      --host <host>          Bind address. Default: 127.0.0.1
      --token <string>       Use a fixed token instead of generating one. Env: VM_MCP_TOKEN
      --readonly             Only expose read-only tools (no write, enable or delete)
      --transport <type>     MCP transport: "stdio" (default) or "http"
```

### Transports

**stdio (default)** - the agent spawns the server as a child process. Nothing is written to stdout except MCP messages; logs go to stderr. The server lives as long as the agent session.

**http** - the server runs standalone and serves [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) MCP at `POST /mcp` on the same port as the extension WebSocket. Use this when the agent is not on the same machine's process tree (remote agents, other devices). Requests must carry `Authorization: Bearer <token>`. Because a restarted server would invalidate the token, pass a fixed `--token` (or `VM_MCP_TOKEN`) in this mode.

```sh
VM_MCP_TOKEN=secret npx @violentmonkey/mcp -p 5678 --transport http
claude mcp add --transport http violentmonkey http://127.0.0.1:5678/mcp --header "Authorization: Bearer secret"
```

Exposing the server beyond localhost (`--host 0.0.0.0`) is your responsibility; put it behind TLS and treat the token as a password. See [docs/security.md](docs/security.md).

## Tools

| Tool | Description | Annotations | Violentmonkey version |
| --- | --- | --- | --- |
| `vm_status` | Whether the extension is connected, its version, and the connect URL. Works even when disconnected. | read-only | — |
| `scripts_list` | List scripts (id, name, namespace, version, enabled, matches). | read-only | >=2.49.5 |
| `scripts_get` | Get a script's metadata and source code by id. | read-only | >=2.49.5 |
| `scripts_write` | Create or update a script from source code. With `id` it updates that script; without `id` it matches by `@name` and `@namespace`, or creates a new one. Returns whether it was created. | idempotent | >=2.49.5 |
| `scripts_set_enabled` | Enable or disable a script. | idempotent | >=2.49.5 |
| `scripts_delete` | Remove a script. | destructive | >=2.49.5 |
| `scripts_test_match` | Whether a script's source would be injected at a URL, answered by the extension's own matcher. | read-only | >=2.49.6 |
| `tabs_list` | Tabs the user has granted to the agent. Empty until they grant one. | read-only | >=2.49.6 |
| `tab_scripts` | What the extension attempted to run on a granted tab, including failures. | read-only | >=2.49.6 |
| `tab_reload` | Reload a granted tab so scripts are re-injected. Returns the new `loadId`. | idempotent | >=2.49.6 |
| `script_logs` | Read `GM_log` output for a granted tab, paged by a `seq` cursor. | read-only | >=2.49.6 |
| `script_handlers` | Named handlers that userscripts registered with `GM.mcp` in a granted tab, with their descriptions and input schemas. | read-only | |
| `script_call` | Call a registered handler with JSON params and return its result. | destructive, open-world | |
| `script_results` | Read retained calls and reports for a granted tab, paged by a `seq` cursor. | read-only | |

`—` means the tool is handled by the server and needs no Violentmonkey support. The extension reports which tools it implements when it connects, and the server exposes only those, so an unimplemented tool is never listed — it does not appear and then fail.

The tab tools (`tabs_list`, `tab_scripts`, `tab_reload`, `script_logs`, `script_handlers`, `script_call`, `script_results`) also need the user to grant a tab first. A grant is created explicitly in the Violentmonkey dashboard, lives in extension memory, and is revoked when its tab closes. Calling a tab tool on a tab that is not granted fails with `403`. `tab_reload` is a plain reload, not navigation. See [docs/contract.md](docs/contract.md) for the full contract.

Exact input/output schemas live in [`packages/protocol`](packages/protocol) and are the single source of truth.

In `--readonly` mode only read-only tools are exposed, which excludes `scripts_write`, `scripts_set_enabled`, `scripts_delete`, `tab_reload` and `script_call`.

Only tools the connected extension reports in its handshake are exposed. Before the extension connects, `tools/list` contains `vm_status` alone; the list is refreshed when the connection changes. Calling a tool that is not exposed returns an error result. A call that races a disconnect still fails with code `503` and the message `Violentmonkey is not connected`. Over the HTTP transport this is a tool result, not an HTTP status, since the HTTP request itself succeeded.

## Security

The server binds to localhost, requires a token, and only accepts connections from the browser extension. Use `--readonly` if the agent should only be able to read your scripts. See [docs/security.md](docs/security.md) for the threat model.

## More

- [docs/design.md](docs/design.md): how it works.
- [docs/protocol.md](docs/protocol.md): the extension WebSocket protocol.
- [DEVELOPMENT.md](DEVELOPMENT.md): packages, building, testing, releasing, and integrating the client library into the extension.

## License

MIT

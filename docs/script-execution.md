# Proposal: opt-in userscript handlers and structured results

An agent developing a userscript can currently install or update it, reload a granted tab, and inspect `GM_log` output. Testing a function with several inputs requires editing the script or adding an application-specific trigger. Log strings also require an application-specific convention to associate an asynchronous result with the request that produced it.

This proposal lets a script explicitly register named handlers, plus a bounded channel for structured results. An agent could discover what each handler does and expects, call a script's validation or calculation function with JSON input, and receive its return value or error without rerunning the script's top-level initialization. A script could also deliberately report results from events it observes, on its own or attached to a call.

Status: the API follows the shape agreed in the extension review (`GM.mcp = { register, report }`, named handlers with descriptions and input schemas, a call-bound `report`). As of 2026-11-03 the paired implementation passes all 46 real-browser regression cases in Chrome 156 (MV3). Firefox runtime validation is still pending; see [Validation](#validation).

## Scope decision

The current [development contract](contract.md#non-goals) excludes externally driving userscripts and treats `GM_log` as the feedback boundary. Callable handlers would intentionally extend that scope. This proposal asks whether that extension is desirable before requesting a release; it does not assume that callback registration alone resolves the product or permission decision.

Invocation requires a connected MCP session, an explicitly granted tab, an enabled installed script and a handler registered in that document. Scripts opt in using `@grant GM.mcp` (or `GM_mcp`) and an explicit registration call. Results contain only what the script returns or reports. No generic evaluation, DOM query, navigation, console capture or network capture tool is added. Registration is an application-level opt-in, not a new security sandbox: an agent already allowed to edit scripts can add a handler, and a handler can perform the same actions as its userscript.

File saving, download directories, local filesystem access and application-specific integrations are deferred to a separate proposal. Existing `GM_download` behavior is unchanged.

## Userscript API

```js
// ==UserScript==
// @name         MCP calculation example
// @namespace    mcp-example
// @version      1.0.0
// @match        https://example.com/*
// @grant        GM.mcp
// ==/UserScript==

GM.mcp.register({
  sum: {
    description: 'Adds two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    handle({ params, report }) {
      if (typeof params?.a !== 'number' || typeof params?.b !== 'number') {
        throw new Error('Expected numeric a and b');
      }
      return { sum: params.a + params.b };
    },
  },
});

// Optional unsolicited report; does not register a callable handler.
GM.mcp.report({ event: 'ready' });
```

`GM.mcp.register(handlers)` registers handlers by name and resolves to an `unregister()` function once the extension accepted them. Names are 1–64 letters, digits, `_`, `.` or `-`. Registering an existing name replaces it and keeps the script's other handlers; a script may have up to 32 handlers per frame. `unregister()` removes only the handlers that call added and that were not replaced since. `GM_mcp` is the same object for `@grant GM_mcp`.

`description` and `inputSchema` are shown to the agent. The schema is a hint: the extension does not validate params against it, so the handler validates its own input.

`handle({ params, report })` may return synchronously or asynchronously; its result settles the call. `undefined` becomes `null`; other values must be JSON serializable. Thrown errors, rejected promises and invalid return values settle the call as failed. Scripts never handle call IDs: `report(value, { error }?)` is bound to its call, adds a report attached to it, may be called any number of times, and stays usable after the call settled or timed out. It rejects once the document was replaced, access was revoked or the call is no longer retained.

`GM.mcp.report(value, { error }?)` adds a report that is not tied to a call.

## MCP tools

| Tool | Input | Output |
| --- | --- | --- |
| `script_handlers` | `tabId` | `scripts: [{ scriptId, frameId, handlers: [{ name, description?, inputSchema? }] }]` |
| `script_call` | `tabId`, `scriptId`, `handler`, optional `frameId`, `params`, `callId`, `wait`, `timeoutMs` | `result: Call` |
| `script_results` | `tabId`, optional `scriptId`, `callId`, `afterSeq`, `limit` | `entries: (Call \| Report)[]`, `nextSeq`, `dropped` |

All three tools require tab authorization. `script_call` defaults to frame 0, `params: null`, `wait: true` and a 10-second execution timeout; the permitted timeout is 1–25,000 ms. The server's default 30-second transport timeout leaves time to return an execution timeout record. Deployments overriding that transport timeout should keep it above the requested execution timeout.

Both entry kinds contain `scriptId`, `frameId`, an opaque `documentId`, `seq` and optional `value` or `error`. A call (`kind: "call"`) also has `callId`, `handler`, `startedAt`, `status` and optional `finishedAt`. Status is `pending`, `completed`, `failed`, `timed_out` or `cancelled`. A report (`kind: "report"`) has `reportedAt` and, when it belongs to a call, that call's `callId`. Timestamps are milliseconds since the epoch. Call IDs are nonempty strings of at most 128 characters, generated by the extension when omitted.

For example, after granting and reloading the tab and reading `script_handlers`:

```json
{"tabId": 7, "scriptId": 1, "handler": "sum", "params": {"a": 2, "b": 3}, "callId": "sum-1"}
```

Pass this to `script_call`; a successful execution returns `result.status: "completed"` and `result.value.sum: 5`. For long-running work, use `wait: false` and poll `script_results` with the returned call ID, which also returns the call's reports. Reads default to 50 entries and allow 1–100; `afterSeq` is an exclusive cursor and `nextSeq` can be used for the next read. A call's `seq` changes when its status changes. Reads do not consume records, and `dropped` counts evictions cumulatively for the tab's session.

## Errors, limits and lifecycle

Protocol errors cover invalid arguments, missing handlers and denied access. Script errors are returned in a valid execution record; a successful MCP request does not imply a successful script. Read-only mode exposes handler discovery and result reads, but excludes `script_call`, which is marked potentially destructive and open-world.

A timeout ends the wait, not the script or its side effects. A late return value can update a retained `timed_out` record to `completed` or `failed`. Reusing a retained call ID with the same script, frame, handler and serialized parameters returns the existing record without invoking the handler again. Different arguments with that ID fail. Eviction, disconnect or restart removes this deduplication guarantee, and reports left from an evicted call are dropped when its ID is reused; there is no durable exactly-once execution. Clients should not automatically retry side effects with a fresh ID.

The extension limits serialized input and output to 256 Ki characters each, errors to 8,192 characters, and pending calls to 32 per tab. Settled calls and reports expire after five minutes, and reporting keeps a call retained; count and byte pressure may evict them earlier. Retention is capped at 100 entries and approximately 2 MiB per tab, with pending calls protected from eviction and bounded separately by the per-call and concurrency limits.

Navigation or reload cancels unfinished calls for the replaced document. Closing a tab, revoking its grant or disconnecting clears its channels and retained results. These operations do not undo effects already performed by a script. Back/forward cache restoration renews the channel and restores registered handlers with their metadata without rerunning script initialization, provided the original authorization session still exists. Old calls are not replayed and their return values and reports remain invalid. Main frames and child frames can restore in either order. A revoked or replaced session requires explicit authorization and a reload.

## Implementation and compatibility

The MCP repository owns the three tool schemas, typed client interfaces, capability negotiation and transport tests. The companion extension change owns the GM APIs, authorization checks, per-document dispatch, result retention and page lifecycle. Tools are exposed only when both server and extension support them; existing extensions retain their current tool list. The existing JavaScript client transport can advertise the new names, while a protocol/client package release makes them available to typed consumers.

No package version or minimum extension release is assigned by this draft. Coordinate the MCP package release and extension rollout if the proposal is accepted. The extension can be tested against a local build of this repository before publishing.

## Validation

The paired implementation was tested on 2026-11-03 with Google Chrome 156.0.8078.80 on macOS arm64, using a headed browser, an isolated profile, the unpacked MV3 extension build and the per-extension "Allow User Scripts" switch.

The tests used an MCP SDK client over Streamable HTTP, the actual MCP server, its WebSocket connection to the extension, and installed userscripts. No simulated extension backend was used. `GM_mcp` was exercised in `@inject-into page` and `GM.mcp` in `@inject-into content`. Both scripts ran in the top document, a same-origin iframe and a cross-origin iframe, with 12 named handlers each.

All 46 browser regression cases passed:

| Area | Verified behavior |
| --- | --- |
| Registration | Named handlers with descriptions and input schemas in both realms and all frame contexts; `unregister()` removes only its own handlers |
| Calls and results | Synchronous JSON and falsy values, asynchronous returns, concurrent response correlation, call-bound reports before and after settling, unsolicited reports and exclusive result cursors |
| Failures and limits | Thrown errors, rejected promises, circular values, BigInt, oversized inputs and outputs, unknown or missing handler names, missing frame handlers and disabled scripts |
| Call lifecycle | Retained call-ID deduplication, conflicting reuse with other params or handler, `wait: false`, execution timeout and late completion |
| Page restoration | Real back/forward cache restoration, renewed document channels, handlers and their metadata restored in both realms and all three frame contexts, no repeated script initialization |
| Authorization and cleanup | Revocation and regrant, rejection of cached old authorization sessions, reload, disconnect/reconnect, read-only mode and tab closure |

Back and forward navigation produced trusted native `pageshow` events with `persisted === true`; the check did not substitute a reload for restoration. Script closure instances survived with an initialization count of one, while document IDs changed. Navigation cancelled unfinished calls, and late replies could not overwrite those cancelled records. Restored handlers could still be called and report results. No unexpected page JavaScript errors were observed.

The MCP automated suite (28 tests), typecheck and build pass, as do the companion extension suite (172 tests), lint, and MV2/MV3 builds. Successful builds do not establish runtime compatibility. Firefox still needs real-browser checks before claiming cross-browser validation.

Chrome removed Manifest V2 support starting with version 139, as documented in the [official support timeline](https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline). Current Chrome verification therefore targets MV3. Legacy Chrome MV2 runtime checks would require an explicitly agreed older-browser compatibility target; they are not part of current Chrome validation. File saving remains outside this first round.

## Questions for maintainers

1. Is explicit callback invocation an acceptable extension of the current development-only scope, or should the initial feature be limited to unsolicited structured reports?
2. ~~Are two new GM APIs appropriate, and should the proposed names or registration model change?~~ Agreed in review: one `GM.mcp` namespace with named handlers and a call-bound `report`.
3. Is the existing per-tab grant sufficient, or should invocation require an additional user-facing permission?
4. Are the timeout, retention, deduplication and back/forward cache semantics suitable for an initial version?

The Chrome results support an initial review of the paired changes. They do not settle the scope or permission decisions above. This proposal intentionally identifies an extension to the existing development contract rather than treating that extension as already accepted.

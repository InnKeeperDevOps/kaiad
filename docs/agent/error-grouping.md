---
title: Error grouping
nav_order: 5
parent: Install Agent
---

# Error grouping

Kaiad watches the log stream from each enrolled agent for error-level
lines and normalizes them into deduplicated **error groups**. Each
group can surface as an incident you can track and triage. This page
covers what you see, how groups are formed, and the lifecycle states a
group moves through.

## In the panel

The Agents page shows an **Error Groups** section per agent. Each row
is one error group with:

- **Status badge** (see [Lifecycle](#lifecycle) below).
- **Sample message** — one representative line; the full deduplicated
  set lives behind it.
- **First / last seen** timestamps and an event count.
- **Service** the group originated from.

A live WebSocket subscription updates the section in place as new
groups appear and existing groups change status.

## How groups are formed

Each `app_log_error` frame the agent emits carries:

- `agentId`, `serviceId`, `message`, `contextLines` (preceding lines
  for context), and `ts`.
- The agent decides what counts as an error-level line; the API
  trusts the classification.

The API normalizes the message before fingerprinting. The
implementation lives in `apps/api/src/errorGrouping.ts:13` and strips:

| Pattern | Replacement |
|---|---|
| ISO/RFC3339 timestamps | `<TS>` |
| `HH:MM:SS` times | `<TIME>` |
| UUIDs | `<UUID>` |
| IPv4 addresses (with optional `:port`) | `<IP>` |
| Long hex tokens (≥8 chars) | `<HEX>` |
| Quoted strings (`"…"` and `'…'`) | `"<STR>"` / `'<STR>'` |
| `path/file.ext:42[:7]` line refs | `path/file.ext:<LINE>` |
| Bare numbers ≥3 digits | `<N>` |

Two errors with the same shape but different request ids therefore
collide into the same group. The fingerprint is
`sha1(serviceId || ' ' || normalizedMessage)`, truncated to 16 hex
chars. This is intentionally noisy on the side of grouping: identical
exception classes from different code paths *may* collide. The
`contextLines` array attached to the group is what disambiguates in the
UI when collisions happen.

## How errors are filtered

On every `app_log_error` the API:

1. **Skips obvious user-input errors.**
   `isProbablyUserInputError` matches conservative patterns
   (`HTTP 4xx`, `bad request`, `unauthorized`, `forbidden`, `not
   found`, `validation error/failed`, `invalid input/payload/json/body`,
   `missing required`, `unprocessable entity`, `schema validation`,
   `zod error`). When it matches, the line is **not** turned into an
   error group at all — user-input errors aren't real service faults.
2. **Upserts the group.** Either creates a new one or bumps the event
   count and last-seen timestamp on an existing fingerprint.

## Lifecycle

| Status | Set by | Meaning |
|---|---|---|
| `open` | API on first sighting | The group is active. New occurrences of this fingerprint bump the count and last-seen timestamp. |

The error-group wire schema still carries other status values
(`fixing`, `fixed`, `paused`, `missing_auth`) for backward
compatibility, but in practice only `open` is ever set today.

## API endpoints

All three list endpoints accept any authenticated session:

```
GET /api/v1/error-groups
GET /api/v1/agents/:agentId/error-groups
GET /api/v1/services/:id/error-groups
```

Response shape: `{ "groups": ErrorGroup[] }` — see
`packages/contracts/src/realtime.ts` for the full schema.

## Realtime events

When a group is created or its status changes the API broadcasts a
`error_group_updated` UI telemetry event over the realtime channel to
every panel session in the tenant. Schema:

```json
{
  "type": "error_group_updated",
  "group": { "id": "...", "status": "open", ... }
}
```

The Agents page subscribes via `useTelemetryStream` and patches the
section in place, so a new error appears as a single update rather than
a re-fetch.

## Privacy and data flow

What leaves the host:

- Lines the agent classifies as error-level (the `app_log_error`
  frame body).
- Up to `SM_LOGSHIP_BUFFER` (default 50) preceding lines as
  `contextLines` for the same service.

What stays on the agent host:

- The raw log file. The shipper buffers lines in memory, not on disk.
- Anything the agent didn't classify as error-level.

What's stored on the API side:

- Per-tenant: the error group rows (fingerprint, normalized message,
  sample message, context lines).

There is no cross-tenant aggregation. Error groups never travel
beyond the tenant that owns the service the error came from.

## See also

- [Agent runtimes]({% link agent/runtimes.md %}) — `SM_LOGSHIP_BUFFER`
  and how the agent decides what's an error-level line.
- [HTTP API reference]({% link reference/api.md %}#error-groups) —
  request/response schemas.

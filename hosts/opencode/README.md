# crew on OpenCode (prototype)

This exists so a crew member can run on OpenCode and still appear on the same crew dashboard, next to the Claude Code
members (crew-code#11, step 3).

It is an OpenCode 2 plugin (`server.ts`). It follows OpenCode's event stream, keeps each member session's crew state, and
writes the beat file the dashboard already reads (`~/.claude/crew/<sessionId>.json`, the `CrewBeat` shape in
`types/index.d.ts`) on every change and every 20 seconds. The rules from events to states are in `beat.ts`, with tests:

```sh
node --test hosts/opencode/beat.node-test.ts
```

## Starting a member on OpenCode

```sh
CREW_AGENT=opencode crew <Name> [--fresh] [--tab]
CREW_AGENT=opencode CREW_OPENCODE_MODEL=deepseek/deepseek-flash crew <Name> --fresh
```

`bin/crew` runs `opencode --standalone` (a private server, so the plugin runs in that member's process and reads its
`CREW_NAME`), loads this directory as a plugin and gives the member's mesh server its own key
(`~/.config/macula-mcp/keys/agent-<name>.key`), all through `OPENCODE_CONFIG_CONTENT`. A resume reopens the OpenCode
session the member's last beat names (`--session`), in `CREW_WORKDIR`. The model is `CREW_OPENCODE_MODEL`
(`provider/model`), else OpenCode's default; the crew plugin's Claude model settings do not apply.

`CREW_DEBUG=<file>` makes the plugin write one line per event it sees, to check it against a new OpenCode release.

## What maps

| Crew state | OpenCode event (2.0.24) |
|---|---|
| working | `session.execution.started` |
| idle | `session.execution.succeeded`, `.failed` (the error is the row's line), `.interrupted` (the reason) |
| needs-you | `permission.asked` until `permission.replied`; the question tool's `form.created` until `form.replied` or `form.cancelled`; a turn that ends on a question (as in the Claude mod) |
| reviewing | a subagent session whose agent or title names a review (`session.created` with `parentID`), while it runs; or `report_progress` with `phase: reviewing` |
| offline | the dashboard's own rule: no beat for a while |

Subagent sessions are not members: their turns and asks count for the session that started them. A session that
existed before the plugin subscribed (`opencode run` creates its session first, with no `session.created` after) is
looked up once with `session.get` to learn whether it is a subagent's.

The row's line is the last line of the member's last answer (`session.text.ended`). Model and cost come from
`session.get`. Context share is the last step's tokens (`session.step.ended`) over the model's window from
`ctx.model.list()`.

Tools: `report_progress` (with `phase`), `crew_park`, `crew_log` and `queue_ask`, with the Claude mod's descriptions,
writing the same files: the beat, `asks/*.json`, `ledger/<ISO week>/<session>.jsonl`. The park flag is a file,
`~/.claude/crew/opencode/park-<Name>`, shown in the beat's `isParked`. Each beat also says `"agent": "opencode"`,
which the launcher reads to resume the right agent; the dashboard ignores it.

## What does not map (yet)

- **waiting.** OpenCode reports no background work or scheduled wake-up at the end of a turn, so a member with work in
  hand shows idle.
- **crew_refresh.** A plugin cannot clear a session and restart it from a handover.
- **The board rules.** The Claude mod puts the crew's board rules in every member's instructions; OpenCode members get
  only what the launcher's prompt says. The board itself works (mcl-kanban over the macula MCP server), but the rules
  belong in core (step 1 of #11) for every host to inject.
- **Context share** for a model OpenCode's catalog does not list (a provider declared only in `opencode.json`): null.
- **Rate windows.** OpenCode reports no account usage windows: `fiveHourPercent` and `weekly` are null.
- **Wake-on-idle, bell and desktop notification, `/crew` and the other commands** stay in the Claude mod, which reads
  every member's beat, OpenCode's included.
- **Types.** OpenCode 2's plugin types are not published on npm (`@opencode-ai/plugin` is the 1.x API, which 2.x does
  not load), so `server.ts` types the context it uses itself. It was checked against OpenCode 2.0.24.

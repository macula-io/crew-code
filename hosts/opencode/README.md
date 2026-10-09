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

A member whose entry in the crew plugin's `member_models` setting is an OpenCode model (`provider/model`) runs on
OpenCode on that model with no `CREW_AGENT`, so a mixed crew starts in one command:

```sh
# member_models: Ceres:deepseek/deepseek-v4-pro, Vesta:deepseek/deepseek-v4-pro, Juno:deepseek/deepseek-v4-pro
crew up Supervisor Ceres Vesta Juno
```

`bin/crew` runs `opencode --standalone` (a private server, so the plugin runs in that member's process and reads its
`CREW_NAME`), loads this directory as a plugin and gives the member its own macula server, the crew's macula-mcp
release keyed by the member's name (`MACULA_MCP_AGENT`, so `~/.config/macula-mcp/keys/agent-<name>.key`), all through
`OPENCODE_CONFIG_CONTENT`. That entry replaces any `macula` server in your global OpenCode config, so members never
share its identity. A resume reopens the OpenCode
session the member's last beat names (`--session`), in `CREW_WORKDIR`. The model is `CREW_OPENCODE_MODEL`
(`provider/model`), else the member's own OpenCode model in `member_models`, else OpenCode's default; a Claude model there does not apply.

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

## The crew room

The plugin cannot call MCP tools, so it reads the crew room from the transcript every macula-mcp process on the machine
writes (`~/.macula-mcp/lobby-transcript.sqlite3`, read-only, by row id), judges each message with the same rules as the
Claude mod (`core/crew_room.ts`: attested by the station's publisher, sender on the roster, addressed to this member),
and delivers it into the member's session as a queued prompt (`session.prompt`, `delivery: "queue"`). The room rules go
into the system prompt through the session `context` hook. It works while some macula-mcp process on the machine is in
the room, which every crew session is. Checked live against OpenCode 2.0.24: an addressed message from a roster member
became a turn, a forged one and a stranger's were dropped.

On exit (or when the plugin is unloaded) every member session's beat is written offline at once, so a member that was
closed can be relaunched right away. A process killed outright writes nothing; `bin/crew` therefore counts an OpenCode
member live only while an `opencode` process with its `CREW_NAME` runs.

## What does not map (yet)

- **Waiting on a reply.** The Claude mod sees its own `mesh_say` calls; the OpenCode plugin does not yet, so an
  OpenCode member that asked a question shows idle, not waiting.
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

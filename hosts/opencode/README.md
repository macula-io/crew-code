# crew on OpenCode (prototype)

This exists so a crew member can run on OpenCode and still appear on the same crew dashboard, next to the Claude Code
members (crew-code#11, step 3).

It is an OpenCode 2 plugin (`server.ts`). It follows OpenCode's event stream, keeps each member session's crew state, and
writes the beat file the dashboard already reads (`~/.claude/crew/<sessionId>.json`, the `CrewBeat` shape in
`types/index.d.ts`) on every change and every 20 seconds. The rules from events to states are in `beat.ts`, the
room and server parts in `room.ts` and `server.ts`, with tests:

```sh
node --experimental-strip-types --test hosts/opencode/beat.node-test.ts hosts/opencode/room.node-test.ts \
  hosts/opencode/launcher.node-test.ts hosts/opencode/server.node-test.ts hosts/opencode/macula.node-test.ts \
  hosts/opencode/lifecycle.node-test.ts
```

`lifecycle.node-test.ts` is the #24 headless lifecycle test: it starts a throwaway member in a real tmux session
through `bin/crew`, counts its agent and macula-mcp children with `crew ls`, stops it by process group (a bystander
process proves nothing else is killed) and restarts it. It needs `tmux` and `bash` on PATH and skips with that reason
otherwise.

`macula.node-test.ts` is the #23 integration test: it runs a real `opencode` through a location boot, a second
directory and a reload, and asserts exactly one stub macula server per member and that a room message arriving after
the reload still reaches the member. It needs the OpenCode 2 binary on `PATH` and skips with that reason otherwise; CI
has none (v2 is not on npm, and anomalyco/opencode's public releases stop at v1.18.35), so it runs on a workstation,
not in CI.

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
share its identity. It ships disabled: OpenCode connects MCP servers per location (a directory), and it boots a
location for every directory the process resolves, so an enabled entry would run one macula-mcp per location under one
identity and the copies would flap each other off the station (#23). The plugin enables it in the member's own
directory only (`CREW_WORKDIR`, which the launcher passes), so one member runs one macula-mcp however many locations
its process holds; the module doc comment in `server.ts` carries the mechanism. A resume reopens the OpenCode
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

Tools: `report_progress` (with `phase`), `crew_park`, `crew_log`, `queue_ask` and `crew_restart` (the supervisor restarts a
member headless through the launcher: stop by process group, start in a detached tmux session; `fresh` 1 drops the old
context), with the Claude mod's descriptions, writing the same files: the beat, `asks/*.json`, `ledger/<ISO week>/<session>.jsonl`. The park flag is a file,
`~/.claude/crew/opencode/park-<Name>`, shown in the beat's `isParked`. Each beat also says `"agent": "opencode"`,
which the launcher reads to resume the right agent; the dashboard ignores it.

## The crew room

The plugin cannot call MCP tools, so it reads the crew room from the transcript every macula-mcp process on the machine
writes (`~/.macula-mcp/lobby-transcript.sqlite3`, read-only, by row id), judges each message with the same rules as the
Claude mod (`core/crew_room.ts`: attested by the station's publisher, sender on the roster, addressed to this member),
and delivers it into the member's session as a queued prompt (`session.prompt`, `delivery: "queue"`). The room rules go
into the system prompt through the session `context` hook. It works while some macula-mcp process on the machine is in
the room, which every crew session is. Checked live against OpenCode 2.0.24: an addressed message from a roster member
became a turn, while a forged one and a stranger's were refused.

OpenCode evicts a location and boots the plugin again in the same process on a long idle member (#22). The reloaded
plugin has no `session.created` event and no session listing to lean on, so it adopts the member session its own beat
names (`session.get`, root sessions only) and reads its room cursor back from `~/.claude/crew/opencode/room-<Name>.json`,
which it writes on each advance. A message that arrives across the gap is therefore delivered once, not skipped; a
brand-new member has no cursor file and still starts at `MAX(id)`, replaying nothing.

Every location boots its own plugin instance, and each one used to deliver the rows it saw to the member's session:
one row could become two or three turns (#19). Delivery is now scoped to the member's own location (the one that runs
its macula server), and before submitting, each message claims a file by `message_id` under
`~/.claude/crew/opencode/delivered/<Name>/` — the atomic gate two overlapping instances cannot both pass, so one row
is one turn per member. The claim is removed only if the submit fails, so a retry can still deliver.

On process exit (`/exit`, or the process going away) every member session's beat is written offline at once, so a
member that was closed can be relaunched right away. A plugin reload is not an exit: its teardown leaves the beat
alone, since the next instance adopts the same session. A process killed outright writes nothing; `bin/crew` therefore
counts an OpenCode member live only while an `opencode` process with its `CREW_NAME` runs.

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

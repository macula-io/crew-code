# Changelog

## Unreleased

### Added
- A mixed crew in one command: a member whose `member_models` entry is an OpenCode model (`provider/model`, e.g. `Ceres:deepseek/deepseek-v4-pro`) runs on OpenCode on that model without `CREW_AGENT`, and `crew up <Name...>` brings up only the members named, each in its own kitty tab on its own agent. So `crew up Supervisor Ceres Vesta Juno` starts the Supervisor on Claude and three members on DeepSeek.
- The crew room (#18): one mesh room for the whole crew, on every host. The Supervisor opens it (`room.json`), every session joins it, and `crew` writes the members' node ids (`roster.json`, `crew roster`). A message addressed to a session becomes a turn in it, fenced as a crew member's words; only one attested from a roster node id and addressed to that session gets through, the rest is dropped and counted on the row (`room: N dropped`). Only the Supervisor's node id may relay the owner's decision. A member waiting on a reply shows `waiting on reply from <name>`. Rules in `core/crew_room.ts`, shared by the Claude mod and the OpenCode plugin (which reads the shared macula-mcp transcript). A session fixes its cursor when it joins, so nothing addressed to it after the join is missed, and a delivered body is cut at 4000 characters. Needs macula-mcp 0.46.1. Fable gated the design and the code.

### Fixed
- A crew room message reached a busy session many times (#19): the cursor moved only after the turn was accepted, so every poll meanwhile delivered it again. The cursor now moves first, and only one read of the room runs at a time, in the Claude mod and the OpenCode plugin.
- Every OpenCode member ran under one mesh identity: OpenCode drops an inline MCP entry without a command, so the launcher's per-member key never applied and the global config's `macula` server ran instead. `crew` now gives each OpenCode member a complete `macula` entry (the crew's macula-mcp release, `MACULA_MCP_AGENT=<name>`), which replaces the global one.
- The dashboard drew nothing once `roster.json` sat in `~/.claude/crew`: every `*.json` there was read as a beat. Only a file with a name and a `beatAt` is a beat now, and every field the pane reads has a default, so a sparse beat from another host or an older mod draws too.
- An OpenCode member that exited stayed live for up to ten minutes, so `crew <Name>` refused to relaunch it: the plugin now writes an offline beat on exit, and `crew` counts an OpenCode member live only while its `opencode` process runs.
- OpenCode members, a prototype (#11 step 3): `CREW_AGENT=opencode crew <Name>` starts a member on OpenCode 2 with the `hosts/opencode` plugin, which writes the same dashboard beat (working, reviewing, needs-you, idle, with model, cost and the row's line) and offers `report_progress`, `crew_park`, `crew_log` and `queue_ask`. Not mapped yet: waiting, `crew_refresh`, the board rules in the member's instructions. See `hosts/opencode/README.md`.
- The crew plugin: dashboard (`/crew`), progress bars (`report_progress`), the kanban board loop, a 50% claim limit and a 70% handover limit, handovers and refresh (`/crew-refresh auto | package [all] | on | off | now`), wake-on-idle, the crew goal (`/crew-goal`).
- Package mode: a member keeps its context across the cards of one work package and hands over when the board gives it a card from another, only above 20% context.
- Settings: `supervisor`, `members`, `owner`, `board` (`mesh` or `off`) and `realm`. When there is no board for a member, the dashboard and the prompt say so and nobody is woken to work it.
- The `crew` launcher (kitty), with `CREW_WORKDIR`, `CREW_SUPERVISOR`, `CREW_MODEL`, `CREW_DRY_RUN` and `CREW_HOLD` (start sessions on hold: they park themselves and wait to be told to resume).
- A marketplace file: `/plugin install crew --marketplace macula-io/crew-code`.
- Parking: a parked member is never woken on idle (nor handed over for a wake), and the dashboard shows it parked. A member parks itself with the `crew_park` tool (`parked` 1 or 0, and a reason) when told to stop or wind down, and unparks when told to resume; `/crew-park` and `/crew-park off` are the owner's manual override. A wake-up that finds an earlier stop parks the member and ends the turn. The board rules tell members to name every container or process they start after themselves and stop only those (#3).

- Refresh on request in any mode: the `crew_refresh` tool runs the `/crew-refresh now` flow when the supervisor or the owner tells a member to refresh, and leaves its refresh mode unchanged. Every session's prompt says to call it rather than write a handover by hand (#12).
- An honest "needs you" list at the top of the dashboard: each session waiting on the owner, by tab, with what it waits on. MCP elicitations and engine notifications now count, next to question menus, permission dialogs and closing questions; a waiting row always names what it waits on (#12).
- After a refresh the row shows the context drop for half an hour (`refreshed 53% → 4%`) (#12).
- Assignments survive a refresh: the resume prompt points at the card the member holds and its newest `BRIEF_<date>_<Name>.md`, which the supervisor's prompt tells it to write with each assignment (#12).

- Bundled asks: one menu per change (the prompts say to put a change's code range, tag and fleet commit in one ask); routine asks go to the `queue_ask` tool, the dashboard header shows how many wait, and the supervisor offers them together with `take_asks` in one multi-select menu (#13).

- Budget gauges: the dashboard shows the weekly window (percent used, reset) from Claude Code's own rate-limit reading, a projected run-out (red when it comes before the reset), and a Fable gauge the owner sets with `/crew-budget fable <percent>`; the supervisor's prompt carries the same line as a measurement, never as an order to slow down (#14).

- Alerts: a session switching into needs-you rings the bell in its own kitty tab and shows a desktop notification ("<Name>: <what waits>"), once per switch; `/crew-sound on | off | bell | notify` mutes either or both for the whole crew (#15).

- The factory ledger: append-only JSON lines per session per ISO week under `~/.claude/crew/ledger/`. The mod logs owner waits, menus, cards and refreshes with the cost and weekly gauge at that moment; `crew_log` records package milestones (supervisor: assigned to closed; members: checkpoint, release, fix after shipping, Fable round). `/crew-report [week]` sums cycle time, owner wait, rework, releases and cost per package, cost per member, and gauge points per release (#16).

- A reviewing state: a row shows `reviewing` while a reviewer subagent or a review skill runs, while a reviewer still runs in the background after the turn, or when the member declares it with `report_progress`'s `phase` (#9).

- Worker and reviewer models: `worker_model` and per-member `member_models` set the model the launcher starts each session on (`CREW_MODEL` still overrides); `reviewer_model` (default `fable`) is enforced on every review subagent and named in every prompt; each dashboard row shows its session's model (#10).

- Models per assignment: `crew_model` switches a member's live session to the model its assignment names (`/model`, run by the mod once the turn is idle) and back to its configured model when it finishes or releases a card of that package, parks, or asks; the row shows the model and why; the supervisor's prompt says to name the model in the brief (#17).

### Fixed
- A finished task no longer shows "refresh due after this turn" when that refresh will not run (refresh off, or context under the threshold). The check is made when the task finishes, the same one the turn's end makes (#5).
- A background subagent that ends while its session is idle leaves the dashboard's "waiting on" list at the next beat, so an idle member with nothing live shows idle without a new turn. A subagent's Stop hook also refreshes the list, since it carries the session's background work. Otherwise background shells clear at the next turn's end: the plugin API has no live read of them (#5).

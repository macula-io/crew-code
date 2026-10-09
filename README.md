# crew-code

[![CI](https://img.shields.io/github/actions/workflow/status/macula-io/crew-code/ci.yml?branch=main&label=CI)](https://github.com/macula-io/crew-code/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-D97757?logo=claude&logoColor=white)](https://docs.claude.com/en/docs/claude-code)
[![kitty](https://img.shields.io/badge/terminal-kitty-555?logo=gnometerminal&logoColor=white)](https://sw.kovidgoyal.net/kitty/)
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-support-ea4aaa.svg?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/rgfaber)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/crew-code-full-dark.svg">
    <img src="assets/crew-code-full-light.svg" alt="Macula crew code" width="320">
  </picture>
</p>

<p align="center">
  <strong>Run a coding crew of Claude Code sessions from one dashboard</strong>
</p>

---

## What is crew-code?

A Claude Code plugin plus a small launcher. Each member of the crew is a Claude Code session in its own kitty tab. Every session that loads the plugin checks in to a shared dashboard: its state, context used, cost, the card it holds and a progress bar. Members take their work from a kanban board, hand over to a fresh session before their context runs out, and never push without the owner's yes.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install crew --marketplace macula-io/crew-code
```

Answer `y` to add the marketplace, choose the user scope, then set the plugin's options (below). The launcher is `bin/crew` in this repository; put it on your `PATH` or alias it.

## Settings

| Option | What it is | Default |
|--------|------------|---------|
| `supervisor` | The session that coordinates the crew. It is never woken on idle; members report to it. | `Supervisor` |
| `members` | Member names, comma-separated, in dashboard order. Empty accepts any name. | empty |
| `owner` | The person who watches the dashboard and whose yes every push needs, as the prompts name them. | `the owner` |
| `board` | `mesh`: members take work from an mcl-kanban board. `off`: no board. | `mesh` |
| `realm` | The realm your board is served in (64 hex). Empty uses the macula MCP server's default realm. | empty |

Change them with `/config` or under `pluginConfigs.crew.options` in `~/.claude/settings.json`.

## Commands

| Command | What it does |
|---------|--------------|
| `/crew` | Opens the dashboard: every session, its state, context, cost, card and progress. |
| `/crew-name <Name>` | Names this session on the dashboard. |
| `/crew-refresh auto \| package [all] \| on [percent] \| off \| now` | When this session writes a handover, clears and resumes from it. `package` refreshes when the board hands the member a card from another work package (and only above 20% context); `package all` turns that on for every member but the supervisor. |
| `/crew-goal [refs] [sentence]` | Shows the crew's goal, or sets it: one sentence and the one or two work packages it covers. |
| `/crew-park [off]` | Parks this session: wake-on-idle never wakes it and the dashboard shows it parked. `off` unparks it. The owner's manual override: members park themselves with `crew_park`. |
| `/crew-progress on \| off` | Turns progress reporting on or off for this session. |
| `/crew-sound on \| off \| bell \| notify` | When a session starts waiting on the owner, its kitty tab rings its bell (kitty marks the tab) and a desktop notification names it and what waits: once per switch, never repeated while it waits. `bell` or `notify` keeps one of the two, `off` mutes both, for the whole crew. |
| `/crew-budget [fable <percent> \| fable off]` | Shows the budget gauges, or sets the Fable one, which Claude Code does not report. |

Sessions also get three tools: `report_progress` for the progress bar; `crew_park` (`parked` 1 or 0, and a `reason`), which a member calls itself when the supervisor or the owner tells it to stop or to resume; and `crew_refresh` (a `reason`), which a member calls when told to refresh. It runs the same flow as `/crew-refresh now` (safety check, handover, clear, resume) whatever the member's refresh mode, and leaves that mode as it was.

## Asks for the owner

One menu per change: every session's prompt says to put everything one change needs from the owner (the code range, the tag, the fleet commit, in the order they run) in ONE yes/no ask. A routine ask that is not part of a change (a cleanup, a branch or worktree to delete) goes to the `queue_ask` tool instead of a menu of its own; the dashboard header shows how many wait (`3 asks waiting`), and the supervisor, at a natural pause, calls `take_asks` and offers them all in one multi-select menu. Queued asks are files under `~/.claude/crew/asks/`, one per ask.

## What the dashboard tells you

- **Needs you**, at the top: every session waiting on the owner, by the kitty tab to click and what it waits on. A question menu, a permission dialog, an MCP server asking for input, an engine notification and a turn that ends on a question all count.
- **Waiting** names what the session waits on: background work, a scheduled wake-up, or an unfinished task. A row never says waiting without saying on what.
- **Budget**: the account's weekly window as the sessions read it (percent used, when it resets), a run-out projected at the week's pace so far, shown in red when it comes before the reset, and the Fable gauge the owner sets with `/crew-budget fable <percent>`. The supervisor's prompt carries the same line as a measurement for the owner: the crew's pace changes only when the owner says so.
- **Refresh**: a running refresh shows its phase (due, handing over, clearing), and for half an hour after one the row shows the drop, e.g. `refreshed 53% → 4%`. A handover a member writes on its own is not a refresh and shows nothing.

## Assignments survive a refresh

A refresh clears the member's chat, so its assignment lives outside it: the card it holds on the board, and the supervisor's brief file `~/.claude/sessions/BRIEF_<YYYY-MM-DD>_<Name>.md` (the supervisor's prompt tells it to write one with each assignment). The resume prompt points the fresh session at both, as well as at its handover.

## Limits every session keeps

- At 50% context a member takes no new card: the claim is refused and the session hands over.
- At 70% context it hands over at the next safe point (committed or stashed, approved pushes made).
- An idle member with nothing in hand is woken to work the board, with a doubling back-off; never the supervisor, and never a parked member. A member told to stop or wind down parks itself with `crew_park`; told to resume, it unparks.
- A member names every container or process it starts after itself and stops only those, by exact name.

## The launcher

```
crew up [--fresh]            every member not running, one kitty tab each
crew <Name> [--fresh] [--tab]
crew rename <Old> <New>
crew ls
```

It needs kitty with `allow_remote_control yes`. Members are the `ROLE_<Name>.md` cards in `~/.claude/sessions`, plus the supervisor. Environment: `CREW_WORKDIR` (where sessions start, default `$HOME`), `CREW_SUPERVISOR`, `CREW_MODEL`, `CREW_DRY_RUN=1` to print launches, `CREW_HOLD=1` to start sessions on hold (they read their card and handover, park themselves and wait to be told to resume).

## What you need for what

| You want | You need |
|----------|----------|
| The dashboard, progress bars, context limits, handovers, package refresh | This plugin. Nothing else. |
| Members taking work from a shared board, a crew goal, wake-on-idle | The [macula MCP server](https://github.com/macula-io/macula-mcp), a realm your members are enlisted in, and an [mcl-kanban](https://github.com/macula-services/mcl-kanban) service in that realm. Set `realm` to it. |

The board is reached only over the Macula mesh: a member is trusted because its key is signed into the realm. A team that wants its board private runs its own realm on its own network; there is no unauthenticated mode.

When `board` is `mesh` and there is no board for this member (nothing serves `mcl-kanban`, the member is not enlisted, or the macula server is missing), the dashboard says so in one line, the prompt tells members not to call the board, and nobody is woken to work it. Set `board` to `off` to leave the board out entirely.

## Develop

```
claude plugin validate .
claude plugin test .
```

Load a working copy with `claude --plugin-dir <this folder>`, or list it in `CLAUDE_CODE_PLUGIN_DIRS`.

## License

MIT

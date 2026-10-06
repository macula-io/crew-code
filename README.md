# crew-code

Run a coding crew of Claude Code sessions, each in its own kitty tab, and see all of them on one dashboard.

`crew` is a Claude Code plugin plus a small launcher. Every session that loads the plugin checks in to a shared dashboard (state, context used, cost, the card it holds, a progress bar). Members take their work from a kanban board, hand over to a fresh session before their context runs out, and never push without the owner's yes.

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

Change them with `/config` or under `pluginConfigs.crew.options` in `~/.claude/settings.json`.

## Commands

| Command | What it does |
|---------|--------------|
| `/crew` | Opens the dashboard: every session, its state, context, cost, card and progress. |
| `/crew-name <Name>` | Names this session on the dashboard. |
| `/crew-refresh auto \| package [all] \| on [percent] \| off \| now` | When this session writes a handover, clears and resumes from it. `package` refreshes when the board hands the member a card from another work package (and only above 20% context); `package all` turns that on for every member but the supervisor. |
| `/crew-goal [refs] [sentence]` | Shows the crew's goal, or sets it: one sentence and the one or two work packages it covers. |
| `/crew-progress on \| off` | Turns progress reporting on or off for this session. |

Sessions also get a `report_progress` tool for the progress bar.

## Limits every session keeps

- At 50% context a member takes no new card: the claim is refused and the session hands over.
- At 70% context it hands over at the next safe point (committed or stashed, approved pushes made).
- An idle member with nothing in hand is woken to work the board, with a doubling back-off; never the supervisor.

## The launcher

```
crew up [--fresh]            every member not running, one kitty tab each
crew <Name> [--fresh] [--tab]
crew rename <Old> <New>
crew ls
```

It needs kitty with `allow_remote_control yes`. Members are the `ROLE_<Name>.md` cards in `~/.claude/sessions`, plus the supervisor. Environment: `CREW_WORKDIR` (where sessions start, default `$HOME`), `CREW_SUPERVISOR`, `CREW_MODEL`, `CREW_DRY_RUN=1` to print launches.

## The board

The board loop talks to [mcl-kanban](https://github.com/macula-services/mcl-kanban) over the Macula mesh, through the `macula` MCP server's `mesh_call`. Without that server the dashboard, progress, limits and handovers still work; the board prompts and `/crew-goal` do not.

## Develop

```
claude plugin validate .
claude plugin test .
```

Load a working copy with `claude --plugin-dir <this folder>`, or list it in `CLAUDE_CODE_PLUGIN_DIRS`.

## License

MIT

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

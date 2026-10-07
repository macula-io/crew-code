# Changelog

## Unreleased

### Added
- The crew plugin: dashboard (`/crew`), progress bars (`report_progress`), the kanban board loop, a 50% claim limit and a 70% handover limit, handovers and refresh (`/crew-refresh auto | package [all] | on | off | now`), wake-on-idle, the crew goal (`/crew-goal`).
- Package mode: a member keeps its context across the cards of one work package and hands over when the board gives it a card from another, only above 20% context.
- Settings: `supervisor`, `members`, `owner`, `board` (`mesh` or `off`) and `realm`. When there is no board for a member, the dashboard and the prompt say so and nobody is woken to work it.
- The `crew` launcher (kitty), with `CREW_WORKDIR`, `CREW_SUPERVISOR`, `CREW_MODEL` and `CREW_DRY_RUN`.
- A marketplace file: `/plugin install crew --marketplace macula-io/crew-code`.
- `/crew-park` and `/crew-park off`: a parked member is never woken on idle (nor handed over for a wake), and the dashboard shows it parked. The wake prompt says an earlier stop stands over a wake-up, and the board rules tell members to name every container or process they start after themselves and stop only those (#3).

### Fixed
- A finished task no longer shows "refresh due after this turn" when that refresh will not run (refresh off, or context under the threshold). The check is made when the task finishes, the same one the turn's end makes (#5).
- A background subagent that ends while its session is idle leaves the dashboard's "waiting on" list at the next beat, so an idle member with nothing live shows idle without a new turn. Background shells still clear at the next turn's end: the plugin API has no live read of them (#5).

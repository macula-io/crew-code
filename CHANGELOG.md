# Changelog

## Unreleased

### Added
- The crew plugin: dashboard (`/crew`), progress bars (`report_progress`), the kanban board loop, a 50% claim limit and a 70% handover limit, handovers and refresh (`/crew-refresh auto | package [all] | on | off | now`), wake-on-idle, the crew goal (`/crew-goal`).
- Package mode: a member keeps its context across the cards of one work package and hands over when the board gives it a card from another, only above 20% context.
- Settings: `supervisor`, `members`, `owner`, `board` (`mesh` or `off`) and `realm`. When there is no board for a member, the dashboard and the prompt say so and nobody is woken to work it.
- The `crew` launcher (kitty), with `CREW_WORKDIR`, `CREW_SUPERVISOR`, `CREW_MODEL` and `CREW_DRY_RUN`.
- A marketplace file: `/plugin install crew --marketplace macula-io/crew-code`.

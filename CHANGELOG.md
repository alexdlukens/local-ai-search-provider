# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Opening the chat window before the answer starts streaming (for example by
  pressing `Enter` while the query is still inside the typing debounce) now
  sends the pending question from the chat window instead of leaving it
  unanswered.

## [0.1.0] - 2026-11-07

Initial public release. AI-generated; see the disclaimer in the README.

### Added

- GNOME Shell 50 search provider that streams answers from an OpenAI-compatible
  server into the overview.
- Markdown rendering in the overview row and the chat window, including code
  blocks, lists, quotes, rules, and tables.
- Follow-up chat window with saved conversation history, history browser, copy
  buttons, tool-result cards, and reasoning display.
- Model discovery from `/v1/models`, optional loading progress from
  `/v1/load-progress`, and Auto model selection.
- Built-in tools for date/time, system information, application launching,
  weather, country/population data, Wikipedia search, and currency conversion.
- Optional MCP tools over Streamable HTTP with per-server headers, discovery
  caching, and a settings test action.
- Thinking and reasoning switches, configurable debounce, maximum tool rounds,
  and an Adwaita preferences window.
- **AI Chats** desktop launcher installed by `make install`.
- GPL-3.0-or-later license, security policy, usage guide, architecture notes,
  contribution guide, and packaging checks.

# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A dedicated icon for the **AI Chats** application. `make install` now
  installs the scalable SVG and 16–512 px PNG sizes into the user's hicolor
  icon theme, and the desktop entry uses it instead of a generic symbolic
  icon. `make icons` regenerates the committed PNGs from `data/ai-search.svg`.
- Opening the overview search now starts loading a cold model immediately,
  without waiting for the typing debounce. The warm-up is skipped when the
  server reports the model as already loaded.
- A built-in `get_location` tool reporting the current location from the
  desktop's location service (GeoClue2 over the system D-Bus): latitude,
  longitude, accuracy, place description, and fix time. It sends no request to
  a third-party IP-geolocation service. It is gated by **Enable tools** and
  requires Location Services to be enabled; the desktop may prompt for
  permission, and the tool reports an actionable error when the service is
  unavailable, denied, or times out.
- Built-in `web_search` and `fetch_url` tools. `web_search` queries
  DuckDuckGo's HTML endpoint and returns titles, URLs, and snippets;
  `fetch_url` returns the readable text of one public web page. Both are
  gated by **Enable web data tools**. `fetch_url` refuses loopback, private,
  link-local, multicast, and reserved addresses, checks resolved DNS
  addresses, and re-validates every redirect hop. Neither tool can execute
  code or write files.
- An undo button on the **System prompt** row in preferences restores the
  built-in default prompt. It is insensitive while the default is already in
  effect, and it drops the stored override instead of writing the default back,
  so future default changes still reach the user.
- Live per-turn metrics in the overview answer row and the chat window: time
  to first token, prompt processing speed, generation speed, and token/context
  usage. Generated token counts fall back to estimates when the server
  reports none. Metrics are saved with chat history and reappear when a chat
  is reopened.
- Deleting a single saved chat from its history row without opening it, and
  clearing every saved chat with the **Clear All** button after confirming in
  a dialog. Deleting the open chat resets the window to a new empty chat, and
  **Clear All** is insensitive when nothing is saved.
- A date and time stamp on every user question in the chat window, saved in
  `chats.json` as `ts` (epoch milliseconds) so reopened chats show the original
  times. Chats saved before this change show no timestamp.

### Changed

- The default system prompt now points the model at `web_search` and
  `fetch_url` for current or general information, with Wikipedia as the
  encyclopedic fallback.
- Opening the chat window before the answer starts streaming (for example by
  pressing `Enter` while the query is still inside the typing debounce) now
  sends the pending question from the chat window instead of leaving it
  unanswered.
- The default system prompt now instructs the model to treat its knowledge as
  stale: for time-sensitive questions (current events, office holders, prices,
  releases, versions, scores, statistics) it must call a tool — Wikipedia,
  weather, currency, country data, or `get_datetime` — and answer from the
  result instead of memory, and to flag the answer as possibly out of date when
  no tool can confirm it.
- Opening the chat window from the overview answer or history row now
  dismisses the overview search, so no `Escape` is needed.
- Leaving the overview search without opening the answer — hiding the
  overview, opening the app grid, launching another result, or clearing the
  query — now cancels the in-flight answer. The partial reply is discarded and
  is not written to chat history.
- The **AI chat history** row in the overview now shows how many chats were
  active today (for example **5 chats today**) instead of the total number of
  saved chats. An empty history still says **No saved chats yet**.

### Removed

- The `open_application` built-in tool. GNOME Shell's application search is no
  longer intercepted.

## [0.1.0] - 2026-11-07

Initial public release. AI-generated; see the disclaimer in the README.

### Added

- GNOME Shell search provider that streams answers from an OpenAI-compatible
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

# AI Search

> [!WARNING]
> **AI-generated project.** This extension and its documentation were written
> largely with AI coding assistants. The code has not been security-audited.
> It runs inside GNOME Shell with your full user privileges: it can read
> system information and send data to the model, MCP, and web endpoints you
> configure. Review the code before installing it, keep
> secrets out of shared machines, and use it at your own risk. Model output can
> be wrong; verify anything important. This project is not affiliated with or
> endorsed by GNOME.

AI Search turns the GNOME Shell 50 overview into a front end for a local
OpenAI-compatible model. Type a question and the answer streams directly into
the search results. Click the answer to continue in a chat window with saved
history.

```text
Super → "explain the difference between TCP and UDP" → live answer
      → click the answer → keep asking follow-ups → history is saved
```

The model runs on your machine by default, with no account, telemetry, or
hosted backend. The extension talks to whatever OpenAI-compatible server you
configure. The built-in web data tools are enabled by default and contact
Open-Meteo, the World Bank, Wikipedia, Frankfurter, and DuckDuckGo when the
model calls them; turn **Enable web data tools** off for a fully local setup.
MCP servers are opt-in and contacted only when enabled.

## Features

- Streaming answers inside the overview, with a configurable typing debounce.
- Markdown rendering in both the result row and the chat window: headings,
  emphasis, code blocks, lists, blockquotes, rules, and pipe tables.
- Follow-up conversations in a dedicated GTK chat window with saved history and
  a timestamp on each question; delete one chat from its history row or clear
  all of them after a confirmation.
- Model loading status, including a percentage when the server exposes
  `/v1/load-progress`.
- Works with local servers that implement the OpenAI chat-completions API:
  Unsloth Studio, llama.cpp's `llama-server`, Ollama, and LM Studio.
- Built-in tools for date/time, system information, weather,
  country/population data, Wikipedia, currency conversion, web search,
  approximate location from the public IP, and reading a specific web page.
- Live per-turn metrics under the answer and in the chat window: time to first
  token, prompt processing and generation speed, and token/context usage.
- Optional [Model Context Protocol](https://modelcontextprotocol.io/) (MCP)
  servers for additional tools.
- Optional thinking, plus a display-only reasoning switch.
- Configured with `gnome-extensions prefs ai-search@alexdlukens.github.io`.

## Requirements

- **GNOME Shell 50** (Wayland). This extension uses the Shell 50 search
  provider API and is not compatible with older releases.
- A local server that exposes the OpenAI chat-completions API.
- For source installs: `gjs`, `glib-compile-schemas` (usually
  `libglib2.0-bin`), and the `gnome-extensions` CLI (part of `gnome-shell`).
- Network access to the model endpoint; internet access for the web tools
  (enabled by default) and MCP servers (disabled by default).

## Install

```sh
git clone https://github.com/alexdlukens/gnome-ai-search.git
cd gnome-ai-search
make install
gnome-extensions enable ai-search@alexdlukens.github.io
```

`make install` copies the extension to
`~/.local/share/gnome-shell/extensions/ai-search@alexdlukens.github.io/` and
adds an **AI Chats** entry to the application grid. `make uninstall` removes
both.

A newly installed extension is normally picked up only after logging out
and back in. Then open the settings from a terminal and point it at your
server:

```sh
gnome-extensions prefs ai-search@alexdlukens.github.io
```

### Minimal configuration

1. Start an OpenAI-compatible server. Typical endpoints:

   | Server | Typical base URL |
   | --- | --- |
   | Unsloth Studio | `http://127.0.0.1:8888/v1` |
   | llama.cpp `llama-server` | `http://127.0.0.1:8080/v1` |
   | Ollama | `http://127.0.0.1:11434/v1` |
   | LM Studio | `http://127.0.0.1:1234/v1` |

2. Verify the server from a terminal:

   ```sh
   curl http://127.0.0.1:8888/v1/models
   ```

3. In the extension settings, set **Endpoint URL**. A bare `host:port` gets
   `http://` and `/v1` added automatically.
4. Leave **Model** on **Auto**, or pick a model from the dropdown. Use the
   refresh button after downloading new models.
5. Enable **Tools** if your server and model support function calling. For
   llama.cpp started by Unsloth, enable its chat template (`--jinja`).

The full walkthrough, including server setup for each backend, is in
[docs/USAGE.md](docs/USAGE.md).

## Using it

| Surface | What it does |
| --- | --- |
| **Overview answer** | Streams the answer into a full-width result row. **Loading model…** appears while a cold model starts. |
| **Answer row → click/Enter** | Opens the answer in the chat window and closes the overview search, so the window is visible without pressing Escape. Pressing Enter before the answer starts streaming is fine: the question is sent from the chat window instead. Follow-ups send the earlier turns to the model. |
| **AI chat history** row | Opens the saved-conversation list. |
| **AI Chats** app | Opens the chat window directly from the application grid. |
| **Settings → Chats** | Opens the same conversation list. |
| **Copy button** | Copies an answer from the chat window as Markdown. |

A new overview query starts a new conversation. Clicking the answer continues
that conversation; the chat window's history button reopens older chats.
Conversations are stored as plain JSON in
`~/.local/share/ai-search/chats.json`.

## Configuration

Open the settings from a terminal:

```sh
gnome-extensions prefs ai-search@alexdlukens.github.io
```

| Setting | Default | Notes |
| --- | --- | --- |
| Endpoint URL | `http://127.0.0.1:8888/v1` | Base URL. A bare `host:port` gets `http://` and `/v1` added. A green check or red X shows whether the API is responding. |
| API key | empty | Optional `Authorization: Bearer` token. |
| Model | Auto | Populated from `/v1/models`; leave on Auto to use the loaded model or the first advertised one. |
| System prompt | Markdown + verify-freshness instructions | Prepended to every query. Tells the model to check time-sensitive facts with the tools instead of memory. The undo button on the row drops your custom text and restores this default. |
| Debounce | 400 ms | Extra wait after typing stops, on top of the shell's own 150 ms. |
| Enable thinking | on | Sends `enable_thinking: false` / `reasoning_effort: none` when disabled. Servers without thinking support ignore it. |
| Show reasoning | off | Displays `reasoning_content` in the result row and chat window. Requires thinking. |
| Enable tools | on | Lets the model call tools through function calling. |
| Enable web data tools | on | Weather, country/population, Wikipedia, currency, approximate location, web search, and page-fetch tools. Results return inline; no browser opens. |
| Enable MCP tools | off | Discovers tools from the configured MCP servers. |
| Maximum tool rounds | 3 | Caps tool-call/answer loops per query. |

Changing the endpoint or API key automatically re-checks the server and
refreshes the model list.

## Tools

The model gets standard OpenAI function-calling definitions. Tool calls run
client-side and results are returned inline in the answer and chat window.

| Tool | What it returns |
| --- | --- |
| `get_datetime` | Current local date, time, and timezone. |
| `get_system_info` | OS, hostname, user, GNOME version, session type, CPU, memory, and uptime. |
| `get_weather` | Current conditions and a 1–5 day forecast from Open-Meteo. |
| `get_country_info` | Latest World Bank population, capital, region, income level, and a Wikipedia summary. |
| `search_wikipedia` | Wikipedia search results with summaries and links. |
| `web_search` | DuckDuckGo result titles, URLs, and snippets for arbitrary queries. |
| `fetch_url` | Readable text of one public http(s) page; HTML tags are stripped. |
| `convert_currency` | Reference exchange rates from Frankfurter. |
| `get_location` | Approximate city-level location from the public IP via ipapi.co. |

The built-in tools are read-only: they read local information or query web
providers. The former `open_application` tool was removed, so the model cannot
launch desktop applications and GNOME Shell's own application search is not
intercepted.

In the chat window, each tool result appears as an inline expandable card above
the answer, so you can inspect the source data. The overview row shows only the
model's final answer.

If your model or server does not support tool calling, turn **Enable tools**
off. The model may still return error text instead of an answer if it ignores
the no-tools instruction.

## MCP servers

MCP tools are discovered at request time and exposed to the model with an
`mcp__<server>__<tool>` prefix. Configure them in **Settings → AI Search → MCP
servers**. The value is a JSON array:

```json
[
  {
    "name": "DeepWiki",
    "url": "https://mcp.deepwiki.com/mcp",
    "headers": {},
    "enabled": true
  }
]
```

Only **Streamable HTTP** MCP servers are supported. A private server can use
`headers` for an `Authorization` token:

```json
[
  {
    "name": "Internal",
    "url": "https://mcp.example.com/mcp",
    "headers": {"Authorization": "Bearer YOUR_TOKEN"},
    "enabled": true
  }
]
```

Use **Save & test** in settings to initialize the server and list its tools,
then turn **Enable MCP tools** on. Up to 10 servers are supported; tools are
cached briefly after discovery.

The built-in `web_search` tool queries DuckDuckGo's HTML endpoint, which needs
no API key but is unofficial and can rate-limit or refuse requests. If you need
a guaranteed quota, add a hosted search MCP server (for example Exa, Tavily, or
Brave) and let the model prefer that tool.

## Privacy and security

- The model endpoint receives your query, system prompt, and prior
  conversation turns. Run the server locally and keep it bound to loopback
  unless you understand the exposure.
- Web tools send their arguments (city, country, article or search query,
  currency pair, URL) to Open-Meteo, the World Bank, Wikipedia, Frankfurter,
  DuckDuckGo, or the site being fetched. MCP tools send their arguments to the
  configured MCP server.
- The API key and MCP `Authorization` headers are stored as **plain text in
  dconf**, like all extension settings. Use scoped tokens.
- Chat history is **plain JSON** in `~/.local/share/ai-search/chats.json`; it is
  not encrypted.
- The extension has no telemetry, analytics, or update service of its own.
- Model output is untrusted. Markdown is escaped before rendering, raw HTML is
  shown as text, and links are restricted to `http(s)` and `mailto`.
- The remaining built-in tools are read-only: system information, weather,
  country/population data, Wikipedia, currency rates, web search, and page
  fetching. They run because the model asked for them; disable tools if you do
  not want that capability. `fetch_url` refuses loopback, private, link-local,
  and reserved addresses at every redirect hop, so the model cannot use it to
  probe local services. Turn metrics are computed locally and only stored in
  the chat JSON; they are not sent anywhere. See [SECURITY.md](SECURITY.md) for
  the full threat model.

## Limitations

- GNOME Shell 50 only. The search-provider API used here is not stable across
  releases.
- The extension does not download, start, or manage models. Use your server's
  own tooling.
- Tool calling depends on the model and server. Some small models emit invalid
  JSON or ignore tools.
- Metrics depend on the server reporting `usage`/`timings`. When usage is
  missing, generated token counts and speeds are ~4-chars-per-token estimates
  marked with `~`; prompt counts and speeds may be absent. A context percentage
  requires a discoverable context size from `/props` or `/models`; otherwise
  only absolute tokens are shown.
- Reasoning is displayed only when the server streams `reasoning_content` (or
  `reasoning`). Turning thinking off is a request, not a guarantee.
- MCP support is limited to Streamable HTTP; stdio servers are not supported.
- Chat history is capped at 100 conversations and is not synced.
- A bug in an extension runs inside `gnome-shell`. Watch the log if something
  breaks:

  ```sh
  journalctl -f -o cat /usr/bin/gnome-shell
  ```

## Troubleshooting

If the AI section never appears:

```sh
gnome-extensions info ai-search@alexdlukens.github.io
gnome-extensions enable ai-search@alexdlukens.github.io
```

If the model errors, the message is shown inside the search result. Common
causes are a wrong endpoint, a model name the server does not know, a server
that is still loading the model, or a model that does not support tools.

More fixes are in [docs/USAGE.md](docs/USAGE.md#9-troubleshooting).

## Development

```sh
make schemas   # compile GSettings
make check     # strict schema validation + build the zip
make pack      # build dist/<uuid>.shell-extension.zip
make install   # copy into ~/.local/share/gnome-shell/extensions
make uninstall # remove the extension and AI Chats launcher
```

`chatWindow.js` runs as a separate GJS process so GTK and the shell's Clutter
main loop never share a process. It reuses the same `lib/` modules as the search
provider.

| Path | Purpose |
| --- | --- |
| `extension.js` | Registers the search provider and loads settings. |
| `searchProvider.js` | Streaming overview result, history row, and chat launch. |
| `chatWindow.js` | GTK/Adw chat window, history list, Markdown rendering. |
| `prefs.js` | Adwaita preferences UI and server/tool validation. |
| `lib/openaiClient.js` | OpenAI-compatible HTTP client and SSE parser. |
| `lib/chatEngine.js` | Shared chat loop, tool rounds, and message building. |
| `lib/tools.js` | Built-in local and web tools. |
| `lib/mcp.js` | Streamable HTTP MCP client and tool discovery. |
| `lib/markdown.js` | Dependency-free Markdown → Pango renderer. |
| `lib/metrics.js` | Turn metrics tracker and formatter (TTFT, tok/s, context usage). |
| `lib/chatStore.js` | JSON conversation store shared by both processes. |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the process model, request
lifecycle, and design constraints.

## Contributing

Bug reports, pull requests, and documentation fixes are welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) first. For security issues, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

GNU General Public License v3.0 or later. See [LICENSE](LICENSE).

This project is not affiliated with or endorsed by GNOME. GNOME and GNOME Shell
are trademarks of the GNOME Foundation.

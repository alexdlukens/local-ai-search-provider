# AI Search

GNOME Shell 50 search provider that sends your overview query to a local
OpenAI-compatible model and streams the answer directly into the search results.

- Streaming answers with a configurable typing debounce
- Markdown answers rendered in the overview row and the chat window
- Follow-up questions in a dedicated chat window with saved history
- Model loading status with progress when the server reports it
- Unsloth Studio / llama.cpp / Ollama / LM Studio compatible
- Inline weather, country/population, Wikipedia and currency tools (no browser)
- Optional MCP servers for extra tools, configured in Settings
- Optional thinking, plus a display-only reasoning switch
- Configured through GNOME Extension Manager

```
Super -> "explain the difference between TCP and UDP" -> live answer
      -> click the answer -> keep asking follow-ups -> history is saved
```

## Requirements

- GNOME Shell 50
- A local server exposing the OpenAI chat-completions API
- `libsoup-3.0` (already used by the shell)

For Unsloth Studio, start it locally; its API is normally at
`http://127.0.0.1:8888/v1`. For a llama.cpp `llama-server` started by Unsloth,
enable the chat template (`--jinja`) if you want tool calling.

Verify the server:

```sh
curl http://127.0.0.1:8888/v1/models
```

## Install

```sh
make install
gnome-extensions enable ai-search@local
```

On Wayland, a newly installed extension may only be picked up after logging out
and back in. Then open **Extension Manager -> AI Search -> Settings** (gear
button) and adjust:

| Setting | Default | Notes |
| --- | --- | --- |
| Endpoint URL | `http://127.0.0.1:8888/v1` | Base URL. A bare `host:port` gets `http://` and `/v1` added. A green check or red X next to it shows whether the API is responding. |
| API key | empty | Optional `Authorization: Bearer` token. |
| Model | Auto | Dropdown populated from `/v1/models`; pick a downloaded model or leave it on Auto. Use the refresh button after downloading models. |
| System prompt | Markdown answer request | Prepended to every query. |
| Debounce | 400 ms | Extra wait after typing stops, on top of the shell's own 150 ms. |
| Enable thinking | on | Lets reasoning-capable models think. Turning it off sends `enable_thinking: false` / `reasoning_effort: none`; servers and models without thinking support ignore it. |
| Show reasoning | off | Displays `reasoning_content` in the result row and in the chat window. Requires thinking to be enabled. |
| Enable tools | on | Lets the model call tools. |
| Enable web data tools | on | Weather, country/population, Wikipedia and currency tools. Results are returned inline; nothing opens a browser. |
| Enable MCP tools | off | Discover tools from the servers configured in the MCP section below. |
| Maximum tool rounds | 3 | Caps tool-call/answer loops per query. |

Changing the endpoint or API key automatically re-checks the server and refreshes the model list.

Start typing in the overview. The AI section appears with app results. While a
cold model loads, the row says **Loading model…** (with a percentage when the
server exposes `/v1/load-progress`) instead of leaving you with a generic
spinner.

Click the answer row (or press `Enter` on it) to open it in the chat window.
There you can read the full transcript, ask follow-up questions, and copy any
answer with its copy button. Follow-ups send the earlier turns to the model.

The **AI chat history** row below the answer opens the list of saved
conversations. The same list is available from **Settings -> AI Search ->
Chats**, and from the chat window's history button. Conversations are stored as
plain JSON in `~/.local/share/ai-search/chats.json`.

## Tools

The model gets standard OpenAI function-calling definitions. Tool calls run
client-side; web results come back into the answer and chat instead of opening
a browser.

Core:

- `get_datetime` - current local date, time and timezone
- `get_system_info` - OS, hostname, user, GNOME version, session, CPU, memory, uptime
- `open_application` - open an installed application by name

Web data (no API key):

- `get_weather` - current conditions and a 1-5 day forecast for a city
- `get_country_info` - latest World Bank population, capital, region, income level and a Wikipedia summary
- `search_wikipedia` - Wikipedia search results with summaries and links
- `convert_currency` - reference exchange rates

In the chat window each tool result is shown as an inline expandable card
above the answer, so you can see the source data. The overview row shows the
model's final answer.

The `open_url` browser tool was removed. If your model/server does not support
tool calling, turn **Enable tools** off.

## MCP servers

MCP tools are discovered at request time and exposed with a `mcp__<server>__`
prefix. Configure them in **Settings -> AI Search -> MCP servers**. The value is
a JSON array:

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

Public example: DeepWiki at `https://mcp.deepwiki.com/mcp` provides repository
documentation tools without an account. Private or self-hosted servers can use
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

Only Streamable HTTP MCP servers are supported. Use **Save & test** in settings
to initialize the server and list its tools. Turn **Enable MCP tools** on to
expose those tools to the model.

For general web search, add a hosted search MCP server (for example Exa,
Tavily or Brave); the built-in tools intentionally avoid scraping search
engines.

## Notes and limitations

- Markdown is rendered in both the answer row and the chat window: headings,
  emphasis, inline code, fenced code blocks, lists, blockquotes, rules and pipe
  tables. Raw HTML and unsafe link schemes are shown as text. Links open in the
  chat window; the overview row shows them underlined without click handling.
- A new overview query starts a new conversation. Click a result to continue
  that conversation with follow-ups.
- Chat history is stored locally in plain JSON. Follow-ups include earlier
  turns, so the local server sees the whole conversation.
- Web tools and MCP servers send queries to their respective services. The
  built-in web tools use Open-Meteo, World Bank, Wikipedia and Frankfurter.
- Reasoning is only displayed when the server emits `reasoning_content` (or
  `reasoning`) and **Show reasoning** is on. Turning off **Enable thinking**
  asks the server to skip reasoning generation entirely; servers that do not
  understand the switch may keep thinking.
- The API key and any MCP `Authorization` headers are stored in dconf as plain
  text, like all extension settings. Keep local servers bound to localhost and
  use scoped tokens.
- The extension targets GNOME Shell 50's search-provider API
  (`Main.overview.searchController.addProvider`).

## Troubleshooting

Watch the shell log:

```sh
journalctl -f -o cat /usr/bin/gnome-shell
```

If the section never appears, check that the extension is active:

```sh
gnome-extensions info ai-search@local
```

If the model errors, the message is shown inside the search result. Common
causes are a wrong endpoint, a model name the server does not know, or a model
that does not support tools.

## Development

```sh
make schemas        # compile GSettings
make pack           # build dist/ai-search@local.zip
make install        # copy into ~/.local/share/gnome-shell/extensions
```

`chatWindow.js` runs as a separate GJS process so GTK and the shell's Clutter
main loop never share a process. It uses the same `lib/` modules as the search
provider (`chatEngine.js`, `openaiClient.js`, `tools.js`, `chatStore.js`,
`modelWatch.js`).

# AI Search — usage guide

Server setup, settings, tools, chat history, and troubleshooting. For an
overview, see the [README](../README.md); for internals, see
[ARCHITECTURE.md](ARCHITECTURE.md).

> **AI-generated project.** Review the code and the
> [security notes](../SECURITY.md) before pointing this extension at sensitive
> data.

## 1. Start a model server

AI Search does not include, download, or manage models. It is a front end: you
run a server and load a model yourself. Development and testing used the
**Gemma4 E2B** model running locally in
[Unsloth Studio](https://unsloth.ai/).

The extension needs a server that implements:

- `GET  <base>/models`
- `POST <base>/chat/completions` with `stream: true`

### Unsloth Studio

Start Unsloth Studio and load a model. Its API normally listens on port 8888.
For tool calling with a llama.cpp server started by Unsloth, enable the chat
template (`--jinja`). Some builds expose `GET /v1/load-progress`, which AI
Search uses to show a loading percentage.

### llama.cpp `llama-server`

```sh
llama-server -m /path/to/model.gguf --port 8080 --jinja
```

Use `http://127.0.0.1:8080/v1` as the endpoint. `--jinja` is required for
reliable tool calling.

### Ollama

```sh
ollama serve
ollama pull qwen3:8b
```

Ollama exposes an OpenAI-compatible endpoint at
`http://127.0.0.1:11434/v1`. Use a tool-capable model if you want the built-in
tools to work.

### LM Studio

Start the local server from LM Studio's developer/server tab (default port
1234) and load a model. Use `http://127.0.0.1:1234/v1` as the endpoint.

### Remote servers

Any HTTP endpoint works, including a server on another machine. Use HTTPS and
an API key if the connection leaves loopback: the endpoint receives your
queries, system prompt, and conversation history.

## 2. Install

From a source checkout:

```sh
git clone https://github.com/alexdlukens/local-ai-search-provider.git
cd local-ai-search-provider
make install
gnome-extensions enable ai-search@alexdlukens.github.io
```

`make install` also adds the **AI Chats** launcher, which opens the chat window
from the application grid. Log out and back in after installing or updating;
reloading an extension in place is not reliable on Wayland.

From a release zip:

```sh
gnome-extensions install --force dist/ai-search@alexdlukens.github.io.shell-extension.zip
gnome-extensions enable ai-search@alexdlukens.github.io
```

Build the zip with `make pack`; it is written to `dist/`.

Verify the install with `gnome-extensions info
ai-search@alexdlukens.github.io`; the output should say `State: ENABLED`.

## 3. Configure

Open the preferences:

```sh
gnome-extensions prefs ai-search@alexdlukens.github.io
```

1. Set **Endpoint URL**. A bare `host:port` gets `http://` and `/v1` added; a
   full `.../chat/completions` URL is also accepted. The check next to the
   endpoint shows whether `/models` responds.
2. Set **Model**, or leave it on Auto to use the loaded model or the first
   advertised one. Press the refresh button after downloading new models.
3. Add an **API key** only if the server requires one; it is sent as
   `Authorization: Bearer <key>`.
4. Leave the remaining switches at their defaults unless your server or model
   needs otherwise. The table below lists them.

| Setting | Default | Notes |
| --- | --- | --- |
| Debounce | 400 ms | Wait after typing stops, on top of the shell's own 150 ms. |
| Enable thinking / reasoning | on | Sends `enable_thinking: false` and `reasoning_effort: none` when disabled. Servers without support ignore it. |
| Show reasoning / thinking | off | Displays `reasoning_content` above the answer. Requires thinking. |
| Enable tool calling | on | Lets the model call tools via function calling. |
| Enable web data tools | on | Weather, country data, Wikipedia, currency, web search, and page fetch. |
| Enable MCP tools | off | Discovers tools from the configured MCP servers. |
| Maximum tool rounds | 3 | Caps tool-call/answer loops per query. |
| System prompt | built-in default | Prepended to every query. The undo button restores the default. |

Changing the endpoint or API key re-checks the server and refreshes the model
list.

## 4. Ask from the overview

1. Press `Super` and type. Queries shorter than two characters send no request.
2. Opening the search already asks the server to load a cold model, so the
   debounce does not delay loading. The row shows **Loading model…**, with a
   percentage when the server exposes `/v1/load-progress`.
3. The answer streams into the row with live metrics: time to first token,
   prompt and generation speed, and token/context usage.
4. Press `Enter` or click the answer to open the chat window; the overview
   closes so the window is visible. If the answer has not started yet, the
   chat window sends the question instead.
5. Typing a new query cancels the request in flight.

The overview row shows only the final answer. Reasoning and tool results appear
in the chat window.

![An answer streaming in the AI Search overview row with metrics and the AI
chat history row](images/search_provider.png)

## 5. Use the chat window

![The chat window with a streamed answer, metrics, and the follow-up
composer](images/chat_screen.png)

- Type a follow-up and press `Enter` or the send button. Earlier turns are sent
  with each request.
- Each question shows the date and time it was asked; the timestamp is saved
  with the chat.
- The history button lists saved conversations. Select one to reopen it; use
  the trash button on a row to delete it without opening it, or **Clear All**
  to delete every chat after confirmation. The new-chat button starts an empty
  conversation.
- Use the copy button under an answer to copy its Markdown.
- Tool results appear as expandable cards above the answer, and metrics appear
  under it. Metrics are saved with the conversation.

![Chat history with a row per saved conversation, delete buttons, Clear All,
and the new-chat button](images/chat_history.png)

A new overview query always starts a new conversation. Use the chat window to
continue an existing one.

## 6. Tools

The model decides when to call tools. All built-in tools are read-only: they
read local information or query web providers, and cannot run commands, write
files, or open applications.

| Tool | Enabled by | Returns |
| --- | --- | --- |
| `get_datetime` | **Enable tool calling** | Local date, time, and timezone. |
| `get_system_info` | **Enable tool calling** | OS, hostname, user, GNOME version, session, CPU, memory, uptime. |
| `get_location` | **Enable tool calling** | Position from the GeoClue2 location service: coordinates, accuracy, description, and fix time. Requires Location Services in Settings → Privacy; may prompt for permission. |
| `get_weather` | **Enable web data tools** | Open-Meteo current conditions and a 1–5 day forecast. |
| `get_country_info` | **Enable web data tools** | World Bank population and metadata plus a Wikipedia summary. |
| `search_wikipedia` | **Enable web data tools** | Search results with summaries and links. |
| `web_search` | **Enable web data tools** | DuckDuckGo titles, URLs, and snippets. |
| `fetch_url` | **Enable web data tools** | Readable text of one public http(s) page. |
| `convert_currency` | **Enable web data tools** | Frankfurter reference rates. |

`fetch_url` refuses loopback, private, link-local, multicast, and reserved
addresses, including resolved DNS names, and checks every redirect hop again.

If the model or server does not support function calling, turn off **Enable
tool calling**; otherwise the model may produce malformed calls or error text.

## 7. MCP servers

MCP tools are discovered at request time and exposed as
`mcp__<server>__<tool>`. Only **Streamable HTTP** servers are supported, up to
10; discovery results are cached briefly.

1. Open **Settings → AI Search → MCP servers**.
2. Set the JSON array:

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

3. Press **Save & test** to initialize the server and list its tools.
4. Turn on **Enable MCP tools**.

`headers` can carry a token, for example
`{"Authorization": "Bearer YOUR_TOKEN"}`. Only `http(s)` URLs are accepted.
Unreachable servers are skipped with a warning, but each new query retries
them and adds latency, so remove ones you no longer use.

The built-in `web_search` needs no key but uses DuckDuckGo's unofficial HTML
endpoint, which can rate-limit or refuse requests. Add a hosted search MCP
server such as Exa, Tavily, or Brave if you need a guaranteed quota.

## 8. Where data lives

| Data | Location |
| --- | --- |
| Settings | dconf: `/org/gnome/shell/extensions/ai-search/` |
| Chat history | `~/.local/share/ai-search/chats.json` (plain JSON, up to 100 chats) |
| Extension code | `~/.local/share/gnome-shell/extensions/ai-search@alexdlukens.github.io/` |
| Logs | `journalctl -f -o cat /usr/bin/gnome-shell` |

The search provider and chat window share the history file through a file
monitor, so changes appear in both.

Reset settings:

```sh
gsettings --schemadir ~/.local/share/gnome-shell/extensions/ai-search@alexdlukens.github.io/schemas \
  reset-recursively org.gnome.shell.extensions.ai-search
```

Delete chat history with the trash button, **Clear All**, or by removing the
file.

## 9. Troubleshooting

### The AI section never appears

- Confirm your GNOME Shell version with `gnome-shell --version`.
- Check `gnome-extensions info ai-search@alexdlukens.github.io`, enable the
  extension, and log out and back in.
- Check the log: `journalctl -b -o cat /usr/bin/gnome-shell | grep -i ai-search`.

### The endpoint is unreachable

- Start the server and check `/v1/models` with `curl`.
- Verify the port and whether the server binds to `127.0.0.1` or `0.0.0.0`.
- If the API lives under a path other than `/v1`, enter the full API base, not
  the web UI URL.
- A server that requires a key returns 401 without one.

### "Loading model…" never finishes

The server may still be loading a large model; watch its logs. Without
`/v1/load-progress` the row cannot show a percentage. Try a smaller model.

### The model answers but tools never run

- Turn on **Enable tool calling**, and use a model that supports function
  calling.
- For llama.cpp, start with `--jinja`.
- Some servers silently drop `tools`; check their logs.
- Malformed tool JSON usually means the model is too small; try a larger model
  or disable tools.

### Metrics are missing or shown with `~`

- The server did not report `usage` or llama.cpp-style `timings`. Without them,
  generated token counts and speeds are ~4-chars-per-token estimates, marked
  with `~`; prompt counts and prompt speed may be absent.
- A context percentage also needs a context size from llama.cpp `/props` or
  `/models`; otherwise only absolute token counts are shown.
- With tool rounds, totals accumulate: tokens are summed, speeds are weighted,
  TTFT stays the first token, and context usage reflects the last round.

### MCP test fails

- Use a Streamable HTTP URL, not a stdio command; it often ends in `/mcp`.
- Check headers, tokens, and the `Accept` header the server expects.

### The chat window does not open

- `gjs` must be in `PATH`. The launcher stores the path found at install time;
  reinstall if you moved `gjs`.
- Run the window directly to see a traceback:

  ```sh
  gjs -m ~/.local/share/gnome-shell/extensions/ai-search@alexdlukens.github.io/chatWindow.js
  ```

### Markdown looks wrong

The renderer supports headings, emphasis, inline and fenced code, lists,
blockquotes, rules, and pipe tables. Raw HTML is escaped and shown as text;
unsupported constructs are displayed literally.

## 10. Update and uninstall

Update from a checkout with `git pull && make install`, then log out and back
in. Settings and chats are kept.

`make uninstall` removes the extension and the **AI Chats** launcher. If the
checkout is gone, remove them manually:

```sh
gsettings --schemadir ~/.local/share/gnome-shell/extensions/ai-search@alexdlukens.github.io/schemas \
  reset-recursively org.gnome.shell.extensions.ai-search 2>/dev/null || true
rm -rf ~/.local/share/gnome-shell/extensions/ai-search@alexdlukens.github.io
rm -f ~/.local/share/applications/org.gnome.Shell.Extensions.AiSearch.Chat.desktop
rm -f ~/.local/share/ai-search/chats.json
```

# AI Search — usage guide

This guide covers server setup, installation, configuration, daily use, tools,
MCP servers, data locations, and troubleshooting. For a feature overview, see
the [README](../README.md). For internals, see
[ARCHITECTURE.md](ARCHITECTURE.md).

> **AI-generated project.** Review the code and the
> [security notes](../SECURITY.md) before pointing this extension at sensitive
> data. Model output can be wrong.

## 1. Start a model server

AI Search does not download or manage models. It expects an HTTP server that
implements the OpenAI chat-completions API:

- `GET  <base>/models`
- `POST <base>/chat/completions` with `stream: true`

You can use any compatible server. These are common options.

### Unsloth Studio

Start Unsloth Studio and load a model. Its API normally listens on port 8888:

```sh
curl http://127.0.0.1:8888/v1/models
```

If you use a llama.cpp server started by Unsloth and want tool calling, enable
the chat template (`--jinja`). Some Unsloth builds also expose
`GET /v1/load-progress`, which AI Search uses to show a loading percentage.

### llama.cpp `llama-server`

```sh
llama-server -m /path/to/model.gguf --port 8080 --jinja
```

Use `http://127.0.0.1:8080/v1` as the endpoint. `--jinja` enables the model's
chat template and is required for reliable tool calling.

### Ollama

```sh
ollama serve
ollama pull qwen3:8b
```

Ollama exposes an OpenAI-compatible endpoint at
`http://127.0.0.1:11434/v1`. Use a model that supports tool calling if you want
the built-in tools to work.

### LM Studio

Start the local server from LM Studio's developer/server tab (default port
1234) and load a model. Use `http://127.0.0.1:1234/v1` as the endpoint.

### Remote or self-hosted servers

Any HTTP endpoint works, including a server on another machine. Use HTTPS and an
API key if the connection leaves loopback. Remember that the endpoint receives
your queries, system prompt, and conversation history.

## 2. Install the extension

### From a source checkout

```sh
git clone https://github.com/alexdlukens/local-ai-search-provider.git
cd local-ai-search-provider
make install
gnome-extensions enable ai-search@alexdlukens.github.io
```

`make install` also installs the **AI Chats** desktop entry, which opens the
chat window directly from the application grid.

Log out and back in after installing or updating. GNOME Shell 50 uses Wayland,
and dynamically reloading an extension is not reliable.

### From a release zip

```sh
gnome-extensions install --force dist/ai-search@alexdlukens.github.io.shell-extension.zip
gnome-extensions enable ai-search@alexdlukens.github.io
```

Build the zip with `make pack`; it is written to `dist/`.

### Verify installation

```sh
gnome-extensions info ai-search@alexdlukens.github.io
```

The output should say `State: ENABLED`.

## 3. Configure the server

Open the preferences window:

```sh
gnome-extensions prefs ai-search@alexdlukens.github.io
```

1. Set **Endpoint URL** to your server, for example
   `http://127.0.0.1:8888/v1`. A bare `host:port` gets `http://` and `/v1`
   added automatically; a full `.../chat/completions` URL is also accepted.
2. The green check or red X next to the endpoint shows whether `/models`
   responds. A red X usually means the server is not running or the URL is
   wrong.
3. Set **Model**. Leave it on **Auto** to use the model the server reports as
   loaded, or the first advertised model. If you downloaded a new model, press
   the refresh button.
4. Add an **API key** only if your server requires one. It is sent as
   `Authorization: Bearer <key>`.
5. Adjust **Debounce** if requests start too early. The default is 400 ms on top
   of the shell's own 150 ms.
6. Choose whether to enable thinking, show reasoning, and enable tools. The
   defaults are safe for most local models.

The complete settings reference is in the
[README configuration table](../README.md#configuration).

## 4. Ask from the overview

1. Press `Super` and start typing.
2. Wait for the **AI Search** section. Queries shorter than two characters do
   not start a request.
3. The answer streams into the result row. If the server is cold-starting a
   model, the row shows **Loading model…** with a percentage when the server
   exposes `/v1/load-progress`.
4. Metrics appear under the answer: time to first token, prompt processing and
   generation speed (tok/s), and token/context usage. They update while the
   answer streams and show the final values when it ends.
5. Press `Enter` on the answer, or click it, to open the chat window; the
   overview search closes at the same time, so the window is visible without
   pressing `Escape`. The same applies to the **AI chat history** row. You do
   not have to wait for the answer to start: if the question is still waiting
   on the debounce or the model, the chat window asks it and streams the reply
   there. The **AI chat history** row shows how many conversations were active
   today; opening it lists every saved chat, not just today's.

While a request is in flight, typing a new query cancels the old one. The
overview row only shows the final answer and its metrics; reasoning and tool
cards appear in the chat window.

![An answer streaming in the AI Search overview result row with metrics and the
AI chat history row](images/search_provider.png)

## 5. Use the chat window

The chat window is a separate GTK process, launched by clicking an answer or
from the **AI Chats** app.

![The chat window with a streamed answer, metrics, and the follow-up
composer](images/chat_screen.png)

- Type a follow-up in the composer and press `Enter` (or the send button).
- Earlier turns are sent with each follow-up, so the model sees the
  conversation.
- Each question you send is stamped with the date and time it was asked, shown
  small and dim above the message. The time is saved with the chat, so it is
  the same when you reopen the conversation.
- The history button opens saved conversations. Select one to reopen and
  continue it.
- Each history row has a trash button that deletes that conversation
  immediately, without opening it. Deleting the open chat resets the window to
  a new empty chat.
- **Clear All**, at the right of the history heading, deletes every saved chat
  after you confirm. It is insensitive when nothing is saved; after the last
  chat is gone the page shows the empty-state message.
- The new-chat button starts an empty conversation.
- The back button returns from history to the current chat.
- Use the copy button under an answer to copy its Markdown.
- Code blocks, tables, lists, links, and quotes are rendered natively. Links
  open in your default browser/mail client.
- Tool results appear as expandable cards above the answer.
- Metrics appear under each answer: TTFT, prompt processing and generation
  speed, token usage, and context usage. They update live while the answer
  streams and are saved with the conversation, so reopening a chat shows the
  same values.

![Chat history with a row per saved conversation, delete buttons, Clear All,
and the new-chat button](images/chat_history.png)

A new overview query always starts a new conversation. Use the chat window if
you want to continue an existing one.

## 6. Use the tools

Tools are enabled by default. The model decides when to call them; you do not
invoke them directly.

| Tool | Enabled by | Notes |
| --- | --- | --- |
| `get_datetime` | **Enable tools** | Local date, time, timezone. |
| `get_system_info` | **Enable tools** | OS, hostname, user, GNOME version, session, CPU, memory, uptime. |
| `get_location` | **Enable tools** | Current position from the system location service (GeoClue2, over D-Bus): coordinates, accuracy, description, and fix time. Location Services must be enabled in Settings → Privacy. May prompt for permission; precision varies with the available source. |
| `get_weather` | **Enable web data tools** | Open-Meteo; current conditions plus 1–5 forecast days. |
| `get_country_info` | **Enable web data tools** | World Bank population and metadata plus a Wikipedia summary. |
| `search_wikipedia` | **Enable web data tools** | Search results with summaries and links. |
| `web_search` | **Enable web data tools** | DuckDuckGo results: title, URL, and snippet. |
| `fetch_url` | **Enable web data tools** | Readable text of one public http(s) URL. |
| `convert_currency` | **Enable web data tools** | Frankfurter reference rates. |

All built-in tools are read-only: they read local information and desktop
services, or query web providers. The former `open_application` tool was
removed, so the model cannot launch desktop applications and GNOME Shell's own
application search is not intercepted.

`fetch_url` only accepts `http` and `https`. Loopback, private, link-local,
multicast, and reserved addresses are refused, including when a DNS name
resolves to one, and every redirect hop is checked again. The worst the model
can do with it is read a public page.

The model gets standard OpenAI function definitions. Tool calls run in the
extension or chat-window process and results are fed back into the model's next
turn. **Maximum tool rounds** limits the loop (default 3). When the limit is
reached, the answer includes a notice instead of looping forever.

If the model or server does not support function calling, turn **Enable tools**
off. Otherwise the model may try to call tools, receive a "tools disabled"
notice, or produce malformed calls.

## 7. Add MCP servers

MCP servers add tools that are discovered at request time. AI Search supports
**Streamable HTTP** MCP servers only, up to 10, with a short discovery cache.

1. Open **Settings → AI Search → MCP servers**.
2. Set the JSON array. Example:

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
4. Enable **Enable MCP tools** so the model can see them.

MCP tools are exposed as `mcp__<server>__<tool>`. Headers can carry an
`Authorization` token:

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

Only `http(s)` URLs are accepted. The built-in `web_search` tool already
covers general search through DuckDuckGo without a key; configure a hosted
search MCP server such as Exa, Tavily, or Brave if you need a guaranteed quota
or better ranking.

## 8. Where data lives

| Data | Location | Notes |
| --- | --- | --- |
| Settings | dconf path `/org/gnome/shell/extensions/ai-search/` | Includes endpoint, model, and API key. |
| Chat history | `~/.local/share/ai-search/chats.json` | Plain JSON, up to 100 conversations. |
| Extension code | `~/.local/share/gnome-shell/extensions/ai-search@alexdlukens.github.io/` | Installed by `make install`. |
| Logs | `journalctl -f -o cat /usr/bin/gnome-shell` | Extension errors appear here. |

The chat window and search provider share the history file through a file
monitor, so changes made in one surface appear in the other.

To reset settings:

```sh
gsettings --schemadir ~/.local/share/gnome-shell/extensions/ai-search@alexdlukens.github.io/schemas \
  reset-recursively org.gnome.shell.extensions.ai-search
```

To delete chat history, use the trash button on a history row, or **Clear
All** in the chat window. To remove the whole file by hand instead:

```sh
rm ~/.local/share/ai-search/chats.json
```

## 9. Troubleshooting

### The AI section never appears

- Confirm GNOME Shell 50: `gnome-shell --version`.
- Confirm the extension is enabled:
  `gnome-extensions info ai-search@alexdlukens.github.io`.
- Log out and back in.
- Check the log for import or schema errors:
  `journalctl -b -o cat /usr/bin/gnome-shell | grep -i ai-search`.

### The row says the endpoint is unreachable

- Start the server and verify `/v1/models` with `curl`.
- Check the port and whether the server binds to `127.0.0.1` or `0.0.0.0`.
- If the URL has a path other than `/v1`, enter the full API base, not the web
  UI URL.
- A server that requires an API key returns 401 without one.

### "Loading model…" never finishes

- The server may be loading a large model. Watch its own logs.
- If the server does not expose `/v1/load-progress`, the row cannot show a
  percentage.
- Try a smaller model or increase server startup timeout.

### The model answers but tools never run

- Enable **Tools** in settings.
- Use a model that supports function calling.
- For llama.cpp, start with `--jinja`.
- Some servers silently drop `tools`; check their logs.
- If the model emits malformed tool JSON, the extension shows an error or a
  notice. Try a larger model or disable tools.

### Metrics are missing or shown with `~`

- The server did not report `usage` or llama.cpp-style `timings` in the final
  stream chunk. Servers that support `stream_options.include_usage` give exact
  counts. Without them, generated token counts and speeds fall back to a
  ~4-chars-per-token estimate marked with `~`; prompt token counts and prompt
  tok/s may be absent.
- Context percentage additionally needs a discoverable context size from
  llama.cpp `/props` (`default_generation_settings.n_ctx`) or `/models`
  (`max_model_len`/`context_length`). If neither is available, only absolute
  token usage is shown.
- Enabling tools adds rounds. Totals accumulate across them: prompt and
  generated tokens are summed, speeds are weighted by round token counts, TTFT
  stays the first token of the turn, and context usage reflects the last
  round. Multi-round turns show the round count.

### MCP server test fails

- Use a Streamable HTTP MCP URL, not a stdio command.
- Make sure the URL ends where the server expects (often `/mcp`).
- Check headers and tokens.
- Some servers reject the default `Accept` header; see the server's docs.
- Remove disabled or unreachable servers. They are skipped with a warning,
  but each new query retries them and adds latency.

### The chat window does not open

- `gjs` must be in `PATH`. The **AI Chats** launcher stores the `gjs` path
  found at install time; reinstall if you moved it.
- Run `gjs -m ~/.local/share/gnome-shell/extensions/ai-search@alexdlukens.github.io/chatWindow.js`
  in a terminal to see a traceback.
- Check that the desktop file exists:
  `~/.local/share/applications/org.gnome.Shell.Extensions.AiSearch.Chat.desktop`.

### Markdown looks wrong

The renderer supports a deliberate subset: headings, emphasis, inline code,
fenced code, lists, blockquotes, rules, and pipe tables. Raw HTML is escaped
and shown as text. Unsupported constructs are displayed literally rather than
interpreted.

## 10. Update and uninstall

Update from a checkout:

```sh
git pull
make install
```

Then log out and back in. `make install` overwrites the extension
files but leaves chats and settings in place.

Uninstall:

```sh
make uninstall
```

Manual cleanup, if you deleted the checkout:

```sh
gsettings --schemadir ~/.local/share/gnome-shell/extensions/ai-search@alexdlukens.github.io/schemas \
  reset-recursively org.gnome.shell.extensions.ai-search 2>/dev/null || true
rm -rf ~/.local/share/gnome-shell/extensions/ai-search@alexdlukens.github.io
rm -f ~/.local/share/applications/org.gnome.Shell.Extensions.AiSearch.Chat.desktop
rm -f ~/.local/share/ai-search/chats.json
```

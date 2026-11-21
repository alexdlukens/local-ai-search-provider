# AI Search

> [!WARNING]
> **AI-generated project.** The code and documentation were written largely
> with AI assistants and have not been security-audited. The extension runs
> inside GNOME Shell with your full user privileges: it can read system
> information and send data to the model, MCP, and web endpoints you configure.
> Review the code before installing, keep secrets off shared machines, and use
> it at your own risk. Model output can be wrong. Not affiliated with or
> endorsed by GNOME.

AI Search puts an OpenAI-compatible model in the GNOME Shell overview. Type a
question to get an **AI Search** row, then press `Enter` to open a chat window
with saved history; the model loads and the answer streams there.

- Works with any OpenAI-compatible server: Unsloth Studio, llama.cpp, Ollama,
  LM Studio, or your own.
- Streaming Markdown answers in a GTK chat window with saved conversations.
- Live per-turn metrics: time to first token, prompt and generation speed, and
  token/context usage.
- Read-only built-in tools: date/time, system info, location, weather, country
  data, Wikipedia, currency, web search, and page fetch. Optional MCP servers.
- No account, telemetry, or hosted backend. Web tools are enabled by default;
  turn off **Enable web data tools** for a fully local setup.

## Requirements

- GNOME Shell on Wayland. Older releases are not supported.
- A reachable server implementing the OpenAI chat-completions API. **No model
  is included with this extension**: install a server and download a model
  yourself.
- `gjs`, `glib-compile-schemas` (usually `libglib2.0-bin`), and the
  `gnome-extensions` CLI.

## Install

AI Search is installed from source; it is not distributed on
extensions.gnome.org.

```sh
git clone https://github.com/alexdlukens/local-ai-search-provider.git
cd local-ai-search-provider
make install
gnome-extensions enable ai-search@alexdlukens.github.io
```

`make install` also adds an **AI Chats** launcher; `make uninstall` removes
the extension and the launcher. Log out and back in after installing, then
open the settings:

```sh
gnome-extensions prefs ai-search@alexdlukens.github.io
```

Set **Endpoint URL** to your server's base URL (a bare `host:port` gets
`http://` and `/v1` added). Leave **Model** on Auto, and turn on **Enable tool
calling** if your model supports function calling.

| Server | Typical base URL |
| --- | --- |
| Unsloth Studio | `http://127.0.0.1:8888/v1` |
| llama.cpp `llama-server` | `http://127.0.0.1:8080/v1` |
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |

Development and testing used the **Gemma4 E2B** model running locally in
[Unsloth Studio](https://unsloth.ai/).

## Use

Press `Super` and type at least two characters. An **AI Search** row appears
saying **Press Enter to open chat**; nothing is sent to the model yet. Press
`Enter` or click the row to open the chat window, which loads the model if
needed and streams the answer there. The **AI chat history** row lists saved
conversations, and the **AI Chats** app opens the window directly.

Each overview query starts a new conversation. Chats are stored as plain JSON in
`~/.local/share/ai-search/chats.json`.

![The chat window with a streamed Markdown answer, per-turn metrics, and the
follow-up composer](docs/images/chat_screen.png)

## Privacy

- The model endpoint receives your query, system prompt, and prior turns. Keep
  it on loopback unless you understand the exposure.
- Web tools send their arguments to Open-Meteo, the World Bank, Wikipedia,
  Frankfurter, DuckDuckGo, or the page being fetched. MCP calls go to the
  servers you configure.
- API keys and MCP headers are stored as plain text in dconf; chat history is
  not encrypted.
- The extension has no telemetry. Model output is untrusted and rendered
  escaped; links are limited to `http(s)` and `mailto`.

See [SECURITY.md](SECURITY.md) for the full threat model.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/USAGE.md](docs/USAGE.md) | Server setup, settings reference, tools, MCP, troubleshooting. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process model, request lifecycle, design notes. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, testing, and pull requests. |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability and the threat model. |
| [CHANGELOG.md](CHANGELOG.md) | Release notes. |

## License

GNU General Public License v3.0 or later. See [LICENSE](LICENSE).

GNOME and GNOME Shell are trademarks of the GNOME Foundation.

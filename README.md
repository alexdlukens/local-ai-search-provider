# AI Search

GNOME Shell 50 search provider that sends your overview query to a local
OpenAI-compatible model and streams the answer directly into the search results.

- Streaming answers with a configurable typing debounce
- Unsloth Studio / llama.cpp / Ollama / LM Studio compatible
- Optional function calling with local tools
- Optional streamed reasoning/thinking (off by default)
- Configured through GNOME Extension Manager

```
Super  ->  "explain the difference between TCP and UDP"  ->  live answer
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
| System prompt | concise plain-text answer | Prepended to every query. |
| Debounce | 400 ms | Extra wait after typing stops, on top of the shell's own 150 ms. |
| Show reasoning | off | When on, streams `reasoning_content` above the answer. |
| Enable tools | on | Exposes the local tools below. |
| Maximum tool rounds | 3 | Caps tool-call/answer loops per query. |

Changing the endpoint or API key automatically re-checks the server and refreshes the model list.

Start typing in the overview. The AI section appears with app results. Press
`Enter` on the AI row to copy the full answer to the clipboard; the overview
stays open so you can keep reading while it streams.

## Tools

The model gets standard OpenAI function-calling definitions. Tool calls are
executed client-side in the shell:

- `get_datetime` - current local date, time and timezone
- `get_system_info` - OS, hostname, user, GNOME version, session, CPU, memory, uptime
- `open_application` - open an installed application by name
- `open_url` - open an http(s) URL in the default browser

They are read-only except for the explicit "open" actions, and nothing can run
arbitrary commands or touch files. If your model/server does not support tool
calling, turn **Enable tools** off.

## Notes and limitations

- The answer row is plain text; Markdown is shown as-is.
- Every query is independent; there is no conversation history.
- Reasoning is only displayed when the server emits `reasoning_content` (or
  `reasoning`) and **Show reasoning** is on.
- The API key is stored in dconf as plain text, like all extension settings.
  Keep the server bound to localhost if possible.
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

# Contributing

Thanks for helping improve AI Search. This is an AI-generated project, so
careful review and reproducible bug reports are especially valuable.

## Before you start

- Read [README.md](README.md), [docs/USAGE.md](docs/USAGE.md), and
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Security issues must follow [SECURITY.md](SECURITY.md), not the public issue
  tracker.
- The extension targets **GNOME Shell** generally. Changes that depend on
  version-specific Shell APIs need a compatibility plan.

## Development setup

```sh
git clone https://github.com/alexdlukens/local-ai-search-provider.git
cd local-ai-search-provider
make install
gnome-extensions enable ai-search@alexdlukens.github.io
```

Open the preferences with:

```sh
gnome-extensions prefs ai-search@alexdlukens.github.io
```

Watch extension errors:

```sh
journalctl -f -o cat /usr/bin/gnome-shell
```

On Wayland, log out and back in after reinstalling. A nested Shell session is
also useful for iterating without touching your main session.

There is no npm/yarn/pip dependency. Everything runs on the GJS/GNOME platform
libraries already present on a GNOME Shell system.

## Repository layout

| Path | Purpose |
| --- | --- |
| `extension.js` | Extension entry point and provider registration. |
| `searchProvider.js` | Search provider, streaming result row, chat launch. |
| `chatWindow.js` | Separate GTK/Adwaita chat application. |
| `prefs.js` | Adwaita preferences and server/tool validation. |
| `lib/` | Shared client, chat loop, tools, MCP, Markdown, storage. |
| `schemas/` | GSettings schema. |
| `data/` | AI Chats desktop entry template, source SVG, and installed icon sizes. |
| `docs/` | Usage, architecture, and publishing notes. |

## Code style

- Match the surrounding style: 4-space indent, semicolons, single quotes, ESM
  imports, no external dependencies.
- Keep shell-process code free of GTK/Adw imports. GTK belongs in
  `chatWindow.js` and `prefs.js`.
- Cancel or destroy asynchronous work in `disable()`/`destroy()` paths.
- Escape model-controlled text before rendering. Never inject it into Pango
  markup or pass it to a shell.
- Prefer small, boring changes over new abstractions. There is no build system
  to hide behind.
- Update documentation and the schema `<description>` fields when behavior or
  settings change.

## Testing

Run the packaging check:

```sh
make check
```

Then test the actual surfaces:

1. Settings opens, endpoint check succeeds, model list populates.
2. A query in the overview streams an answer; a second query cancels the first.
3. Clicking the answer opens the chat window for the same conversation.
4. A follow-up in the chat window streams and persists after closing.
5. The history row and the **AI Chats** app both list the conversation.
6. With a tool-capable model, a weather or Wikipedia question shows tool cards.
7. Disabling and re-enabling the extension produces no errors in the journal.
8. `make uninstall` removes the extension and desktop entry cleanly.

If a change affects a server or MCP path you cannot test, say so in the pull
request.

## Pull requests

- Keep pull requests focused. Separate refactors from behavior changes.
- Describe the user-visible effect, the shell version, the model/server used,
  and how you tested it.
- Include the journal output for any Shell-level change.
- Do not include API keys, tokens, private endpoints, or personal chat history.
- By contributing, you agree your contribution is licensed under
  GPL-3.0-or-later.

## AI-assisted contributions

AI-assisted code is welcome. Disclose substantial generation in the pull request
and verify the result yourself: run the extension, check the journal, and test
the paths you changed. Do not submit unreviewed generated changes.

## Commit messages

Use imperative, present-tense subjects, for example:

```text
Stream tool results into the chat window
Fix endpoint normalization for bare host:port
```

## Releases

Release steps are documented in [docs/PUBLISHING.md](docs/PUBLISHING.md).

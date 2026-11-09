# Security policy

> **AI-generated project.** This code has not been security-audited. Treat it as
> experimental software that runs with your full user privileges.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the issue, affected version/commit, reproduction steps, and impact.

If private reporting is unavailable, contact the maintainer through the GitHub
profile linked from the repository and ask for a private channel. There is no
bug bounty and no guaranteed response time, but valid reports will be
acknowledged and fixed as soon as practical.

## Supported versions

Security fixes target the current `main` branch and the latest release. The
extension supports GNOME Shell; older Shell releases are not supported.

## Threat model

AI Search is **not sandboxed**. A GNOME Shell extension runs inside the
compositor process with the same permissions as your user session. The chat
window is a separate GJS process with the same user permissions.

### What the extension can access

- Your settings, including the model API key and any MCP `Authorization`
  headers, stored as plain text in dconf.
- `~/.local/share/ai-search/chats.json`, containing full conversation text.
- Turn metrics (TTFT, token speeds, token and context usage) are computed
  locally and written to `chats.json` with the conversation. They create no new
  network exposure.
- Basic system information exposed by the built-in `get_system_info` tool: OS,
  hostname, username, GNOME version, session type, CPU, memory, and uptime.
- Your current location through the built-in `get_location` tool, which asks
  the desktop's GeoClue2 location service over the system D-Bus. The service
  obeys the desktop Location Services setting and its authorization agent, so
  the position is only returned when location access is enabled and allowed.
  The fix may come from GPS, Wi-Fi, or a coarse network source.
- The network endpoints you configure: the model server, MCP servers, and the
  built-in web tool providers.

### What the model can influence

Model output is untrusted input:

- It can request any enabled tool with arbitrary arguments.
- Built-in tools are read-only. The `open_application` tool was removed, so the
  model cannot launch installed desktop applications.
- It can cause requests to the built-in web providers with model-chosen
  locations, country names, search terms, currency pairs, or public URLs.
- It can call `get_location`, which asks the system GeoClue2 service over
  D-Bus. The tool returns coordinates, accuracy, a description, and the fix
  time to the model. The request is subject to the same Location Services
  setting, permission dialog, and agent authorization as any other desktop
  app; the extension cannot bypass them.
- `fetch_url` accepts arbitrary `http(s)` URLs but refuses loopback, private,
  link-local, multicast, and reserved addresses. It checks both literal
  addresses and every address returned by the system resolver, re-validating
  each redirect hop. This blocks ordinary use of the tool as a local-network
  scanner; it is not a guarantee against DNS rebinding between the check and
  the connection.
- `web_search` and `fetch_url` only read. They cannot run shell commands,
  evaluate code, or write files, and page text is returned to the model as
  data.
- MCP tool calls are forwarded to the configured MCP server. What that server
  does with the arguments is outside this project's control.
- Prompt injection is possible through web results, tool results, MCP output,
  or the model itself. An injected instruction can attempt to trigger tools;
  a fetched page can try to steer the model into fetching other public pages.

The extension includes no shell, code-execution, file-write, or browser tool.
Markdown links are restricted to `http(s)` and `mailto` and open through the
desktop's default handler when clicked.

### Secrets

- The API key is sent as `Authorization: Bearer <key>` to the configured model
  endpoint.
- MCP headers are sent only to their configured MCP server.
- dconf is readable by your user and by processes with access to your session
  bus. It is not a secret store. Prefer no API key for a loopback-only server,
  or use a scoped token.
- An `http://` endpoint sends the key and conversation in plaintext. Use
  `https://` for anything that leaves loopback.

## Hardening recommendations

- Bind the model server to `127.0.0.1` unless you intentionally expose it.
- Keep **Enable tools** off if you do not trust the model or its input sources.
- Keep **Enable MCP tools** off unless you trust every configured server.
- Use scoped, short-lived tokens for remote model or MCP servers.
- Treat chat history as sensitive data. It is plain JSON and is not encrypted.
- Review the code before installing on a shared or managed machine.
- Use a dedicated user account or container for experiments with untrusted
  models.

## Out of scope

- Vulnerabilities in the model server, model weights, MCP servers, or web
  providers.
- Prompt-injection outcomes that require the user to enable tools and then
  approve the resulting tool use by continuing the conversation.
- Data disclosure caused by running an endpoint over plaintext HTTP or by
  exposing a local server to an untrusted network.

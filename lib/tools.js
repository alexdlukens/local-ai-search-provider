// Small, deliberately read-only/local tool set exposed to the model through
// the OpenAI function-calling protocol. These run in the shell extension and
// in the chat window's own process, so they use only Gio/GLib.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'get_datetime',
            description: 'Get the current local date, time and timezone.',
            parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_system_info',
            description: 'Get basic information about this computer: OS, kernel, desktop, memory, CPU and uptime.',
            parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'open_application',
            description: 'Open an installed desktop application by name.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Application name, for example "Files" or "Firefox".',
                    },
                },
                required: ['query'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'open_url',
            description: 'Open an http or https URL in the default browser.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The http(s) URL to open.',
                    },
                },
                required: ['url'],
                additionalProperties: false,
            },
        },
    },
];

function readFile(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(contents) : '';
    } catch {
        return '';
    }
}

function memorySummary() {
    const info = readFile('/proc/meminfo');
    const totalKb = Number(info.match(/^MemTotal:\s+(\d+)/m)?.[1] ?? 0);
    const availableKb = Number(info.match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? 0);
    if (!totalKb)
        return null;
    const toGiB = kb => (kb / 1024 / 1024).toFixed(1);
    return `${toGiB(totalKb - availableKb)} GiB used of ${toGiB(totalKb)} GiB`;
}

function cpuSummary() {
    const info = readFile('/proc/cpuinfo');
    return info.match(/^model name\s*:\s*(.+)$/m)?.[1]?.trim() ?? null;
}

function uptimeSummary() {
    const info = readFile('/proc/uptime');
    const seconds = Number(info.split(/\s+/)[0] ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0)
        return null;
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (days)
        parts.push(`${days}d`);
    parts.push(`${hours}h`, `${minutes}m`);
    return parts.join(' ');
}

function formatDateTime() {
    const now = GLib.DateTime.new_now_local();
    return now.format('%A, %B %-e, %Y at %H:%M:%S %Z (%z)');
}

let _shellVersion;

function shellVersion() {
    if (_shellVersion !== undefined)
        return _shellVersion;
    _shellVersion = null;
    try {
        const [ok, out] = GLib.spawn_command_line_sync('gnome-shell --version');
        if (ok) {
            const match = new TextDecoder().decode(out).trim()
                .match(/(\d+(?:\.\d+)*)/);
            if (match)
                _shellVersion = match[1];
        }
    } catch {
        // Not a GNOME Shell session
    }
    return _shellVersion;
}

function systemInfo() {
    const lines = [];
    const osName = GLib.get_os_info('PRETTY_NAME') || GLib.get_os_info('NAME');
    if (osName)
        lines.push(`OS: ${osName}`);
    lines.push(`Hostname: ${GLib.get_host_name()}`);
    lines.push(`User: ${GLib.get_user_name()}`);
    const shell = shellVersion();
    if (shell)
        lines.push(`GNOME Shell: ${shell}`);

    const session = [GLib.getenv('XDG_SESSION_TYPE'), GLib.getenv('XDG_CURRENT_DESKTOP')]
        .filter(Boolean).join(', ');
    if (session)
        lines.push(`Session: ${session}`);

    const cpu = cpuSummary();
    if (cpu)
        lines.push(`CPU: ${cpu}`);
    const memory = memorySummary();
    if (memory)
        lines.push(`Memory: ${memory}`);
    const uptime = uptimeSummary();
    if (uptime)
        lines.push(`Uptime: ${uptime}`);

    return lines.join('\n');
}

function findApplication(search) {
    const needle = search.toLowerCase();
    let partial = null;

    for (const info of Gio.AppInfo.get_all()) {
        if (!info.should_show())
            continue;

        const id = info.get_id()?.replace(/\.desktop$/i, '');
        const names = [info.get_name(), info.get_display_name(), id]
            .filter(Boolean)
            .map(value => value.toLowerCase());

        if (names.includes(needle))
            return info;
        if (!partial && names.some(value =>
            value.includes(needle) || needle.includes(value)))
            partial = info;
    }

    return partial;
}

function openApplication(query) {
    const search = (query ?? '').trim();
    if (!search)
        return 'Error: no application name was given.';

    try {
        const app = findApplication(search);
        if (!app)
            return `No installed application matching "${search}" was found.`;

        const context = globalThis.global?.create_app_launch_context?.(0, -1) ?? null;
        if (!app.launch([], context))
            return `Could not launch ${app.get_name()}.`;
        return `Opened ${app.get_name()}.`;
    } catch (e) {
        return `Could not open "${search}": ${e.message}`;
    }
}

function openUrl(url) {
    const value = (url ?? '').trim();
    if (!/^https?:\/\//i.test(value))
        return 'Error: only http and https URLs are allowed.';

    try {
        const context = global.create_app_launch_context?.(0, -1) ?? null;
        Gio.AppInfo.launch_default_for_uri(value, context);
        return `Opened ${value}.`;
    } catch (e) {
        return `Could not open ${value}: ${e.message}`;
    }
}

/**
 * Execute a tool call from the model.
 *
 * @param {string} name tool name
 * @param {string} rawArguments JSON-encoded arguments
 * @returns {Promise<string>} result text sent back to the model
 */
export async function executeTool(name, rawArguments) {
    let args = {};
    const raw = (rawArguments ?? '').trim();
    if (raw) {
        try {
            args = JSON.parse(raw);
        } catch (e) {
            return `Error: arguments for ${name} are not valid JSON (${e.message}).`;
        }
    }

    switch (name) {
    case 'get_datetime':
        return formatDateTime();
    case 'get_system_info':
        return systemInfo();
    case 'open_application':
        return openApplication(args.query);
    case 'open_url':
        return openUrl(args.url);
    default:
        return `Error: unknown tool "${name}".`;
    }
}

export const MAX_TOOL_RESULT_CHARS = 8000;

export function truncateToolResult(text) {
    const value = String(text ?? '');
    if (value.length <= MAX_TOOL_RESULT_CHARS)
        return value;
    return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (truncated)`;
}

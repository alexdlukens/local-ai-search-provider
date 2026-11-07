// Minimal Model Context Protocol client for Streamable HTTP servers.
// Supports initialize, tools/list and tools/call with JSON or SSE responses.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_NAME = 'gnome-ai-search';
const CLIENT_VERSION = '0.2';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_SERVERS = 10;

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

const session = new Soup.Session({
    timeout: 30,
    idle_timeout: 30,
});

const toolCache = new Map();
const serverStates = new Map();
let requestId = 0;

function nextId() {
    requestId += 1;
    return requestId;
}

function serverKey(server) {
    return `${server.url}\n${JSON.stringify(server.headers ?? {})}`;
}

function serverState(server) {
    const key = serverKey(server);
    let state = serverStates.get(key);
    if (!state) {
        state = {
            sessionId: null,
            protocolVersion: PROTOCOL_VERSION,
            initialized: false,
            pending: null,
        };
        serverStates.set(key, state);
    }
    return state;
}

function sendAsync(message, cancellable) {
    return new Promise((resolve, reject) => {
        session.send_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable ?? null,
            (source, result) => {
                try {
                    resolve(source.send_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function readLine(dataStream, cancellable) {
    return new Promise((resolve, reject) => {
        dataStream.read_line_async(
            GLib.PRIORITY_DEFAULT,
            cancellable ?? null,
            (stream, result) => {
                try {
                    const value = stream.read_line_finish(result);
                    if (!value) {
                        resolve(null);
                        return;
                    }
                    const line = Array.isArray(value) ? value[0] : value;
                    resolve(line === null || line === undefined
                        ? null
                        : decoder.decode(line));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function readAll(dataStream, cancellable, limit = 256 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        const read = () => {
            dataStream.read_bytes_async(
                8192, GLib.PRIORITY_DEFAULT, cancellable ?? null,
                (stream, result) => {
                    try {
                        const value = stream.read_bytes_finish(result);
                        if (!value) {
                            resolve(decoder.decode(concat(chunks, total)));
                            return;
                        }
                        const data = value.get_data();
                        if (!data || data.length === 0) {
                            resolve(decoder.decode(concat(chunks, total)));
                            return;
                        }
                        chunks.push(data);
                        total += data.length;
                        if (total >= limit) {
                            resolve(decoder.decode(concat(chunks, total)).slice(0, limit));
                            return;
                        }
                        read();
                    } catch (e) {
                        reject(e);
                    }
                });
        };
        read();
    });
}

function concat(chunks, total) {
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
    }
    return combined;
}

function responseHeader(message, name) {
    try {
        return message.response_headers.get_one(name);
    } catch {
        return null;
    }
}

function parseResponseBody(body) {
    try {
        return JSON.parse(body);
    } catch {
        return null;
    }
}

function findResponse(value, id) {
    if (!value || typeof value !== 'object')
        return null;
    if (Array.isArray(value))
        return value.find(item => item?.id === id) ?? null;
    return value.id === id ? value : null;
}

async function readSseResponse(inputStream, id, cancellable) {
    const dataStream = new Gio.DataInputStream({base_stream: inputStream});
    let dataLines = [];

    try {
        while (true) {
            let line = await readLine(dataStream, cancellable);
            if (line === null)
                break;
            line = line.replace(/\r$/, '');

            if (line === '') {
                if (dataLines.length === 0)
                    continue;
                const payload = parseResponseBody(dataLines.join('\n'));
                dataLines = [];
                const response = findResponse(payload, id);
                if (response)
                    return response;
                continue;
            }

            if (line.startsWith('data:'))
                dataLines.push(line.slice(5).replace(/^ /, ''));
        }

        if (dataLines.length > 0) {
            const payload = parseResponseBody(dataLines.join('\n'));
            return findResponse(payload, id);
        }
    } finally {
        dataStream.close(null);
    }

    return null;
}

/**
 * POST a JSON-RPC message. Returns the matching response (or null for
 * notifications) plus any session id advertised by the server.
 */
async function post(server, payload, {cancellable, state}) {
    const url = server.url;
    const message = Soup.Message.new('POST', url);
    if (!message)
        throw new Error(`Invalid MCP URL: ${url}`);

    message.request_headers.append('Content-Type', 'application/json');
    message.request_headers.append('Accept', 'application/json, text/event-stream');
    message.request_headers.append('User-Agent', `${CLIENT_NAME}/${CLIENT_VERSION}`);
    if (state?.sessionId)
        message.request_headers.append('Mcp-Session-Id', state.sessionId);
    if (state?.protocolVersion)
        message.request_headers.append('MCP-Protocol-Version', state.protocolVersion);

    for (const [name, value] of Object.entries(server.headers ?? {})) {
        if (name && typeof value === 'string')
            message.request_headers.append(name, value);
    }

    message.set_request_body_from_bytes(
        'application/json',
        new GLib.Bytes(encoder.encode(JSON.stringify(payload))));

    const inputStream = await sendAsync(message, cancellable);
    const status = message.get_status();
    const sessionId = responseHeader(message, 'Mcp-Session-Id');
    const contentType = responseHeader(message, 'Content-Type') ?? '';

    if (status === 202 || status === 204) {
        inputStream.close(null);
        return {response: null, sessionId};
    }

    if (status < 200 || status >= 300) {
        const dataStream = new Gio.DataInputStream({base_stream: inputStream});
        let body = '';
        try {
            body = await readAll(dataStream, cancellable, 16 * 1024);
        } finally {
            dataStream.close(null);
        }
        const trimmed = body.trim().slice(0, 300);
        throw new Error(`HTTP ${status}${trimmed ? `: ${trimmed}` : ''}`);
    }

    if (payload.id === undefined) {
        inputStream.close(null);
        return {response: null, sessionId};
    }

    let response;
    if (contentType.includes('text/event-stream')) {
        response = await readSseResponse(inputStream, payload.id, cancellable);
    } else {
        const dataStream = new Gio.DataInputStream({base_stream: inputStream});
        let body = '';
        try {
            body = await readAll(dataStream, cancellable);
        } finally {
            dataStream.close(null);
        }
        const parsed = parseResponseBody(body);
        response = findResponse(parsed, payload.id);
        if (!response && parsed?.jsonrpc)
            response = parsed;
    }

    if (!response)
        throw new Error('MCP server did not return a JSON-RPC response');

    if (response.error) {
        const detail = response.error.message ?? JSON.stringify(response.error);
        throw new Error(`MCP error: ${detail}`);
    }

    return {response, sessionId};
}

async function initialize(server, {cancellable}) {
    const state = serverState(server);
    if (state.initialized)
        return state;

    if (state.pending)
        return state.pending;

    state.pending = (async () => {
        const id = nextId();
        const {response, sessionId} = await post(server, {
            jsonrpc: '2.0',
            id,
            method: 'initialize',
            params: {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: {
                    name: CLIENT_NAME,
                    version: CLIENT_VERSION,
                },
            },
        }, {cancellable, state});

        if (sessionId)
            state.sessionId = sessionId;
        if (response?.result?.protocolVersion)
            state.protocolVersion = response.result.protocolVersion;

        await post(server, {
            jsonrpc: '2.0',
            method: 'notifications/initialized',
        }, {cancellable, state});

        state.initialized = true;
        return state;
    })();

    try {
        return await state.pending;
    } finally {
        state.pending = null;
    }
}

/**
 * Parse the JSON string stored in the mcp-servers setting.
 * Invalid entries are skipped unless the JSON itself is malformed.
 */
export function parseMcpServers(raw, {strict = false} = {}) {
    let value;
    try {
        value = JSON.parse(raw || '[]');
    } catch (e) {
        throw new Error(`MCP configuration is not valid JSON: ${e.message}`);
    }

    if (!Array.isArray(value))
        throw new Error('MCP configuration must be a JSON array.');
    if (value.length > MAX_SERVERS) {
        throw new Error(`Use at most ${MAX_SERVERS} MCP servers.`);
    }

    const servers = [];
    for (let index = 0; index < value.length; index++) {
        const entry = value[index];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            if (strict)
                throw new Error(`Server ${index + 1} must be a JSON object.`);
            continue;
        }

        const url = String(entry.url ?? '').trim();
        if (!/^https?:\/\//i.test(url)) {
            if (strict)
                throw new Error(`Server ${index + 1} needs an http(s) URL.`);
            continue;
        }

        if (entry.headers && (typeof entry.headers !== 'object' ||
            Array.isArray(entry.headers))) {
            if (strict)
                throw new Error(`Server ${index + 1} headers must be a JSON object.`);
        }

        const host = url.match(/^https?:\/\/([^/]+)/i)?.[1] ?? 'MCP';
        const name = String(entry.name ?? '').trim() || host;
        const headers = {};
        if (entry.headers && typeof entry.headers === 'object' &&
            !Array.isArray(entry.headers)) {
            for (const [key, headerValue] of Object.entries(entry.headers)) {
                if (key && typeof headerValue === 'string')
                    headers[key] = headerValue;
            }
        }

        servers.push({
            name,
            url,
            headers,
            enabled: entry.enabled !== false,
        });
    }

    return servers;
}

/**
 * Discover the tools exposed by one MCP server. Results are cached briefly;
 * pass {force: true} to bypass the cache.
 */
export async function listMcpTools(server, {cancellable, force = false} = {}) {
    const key = serverKey(server);
    const cached = toolCache.get(key);
    if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS)
        return cached.tools;

    const state = await initialize(server, {cancellable});
    const id = nextId();
    const {response} = await post(server, {
        jsonrpc: '2.0',
        id,
        method: 'tools/list',
        params: {},
    }, {cancellable, state});

    const tools = Array.isArray(response?.result?.tools)
        ? response.result.tools
        : [];
    toolCache.set(key, {fetchedAt: Date.now(), tools});
    return tools;
}

/**
 * Call one MCP tool and flatten its text content.
 */
export async function callMcpTool(server, toolName, args, {cancellable} = {}) {
    const state = await initialize(server, {cancellable});
    const id = nextId();
    const {response} = await post(server, {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
            name: toolName,
            arguments: args ?? {},
        },
    }, {cancellable, state});

    const result = response?.result;
    if (!result)
        return 'MCP tool returned no result.';

    const parts = [];
    for (const item of Array.isArray(result.content) ? result.content : []) {
        if (item?.type === 'text' && typeof item.text === 'string')
            parts.push(item.text);
        else if (item?.type === 'image')
            parts.push('[image result]');
        else if (item?.type === 'resource')
            parts.push(`[resource: ${item.resource?.uri ?? 'unknown'}]`);
    }

    if (parts.length === 0 && result.structuredContent)
        parts.push(JSON.stringify(result.structuredContent, null, 2));

    const text = parts.join('\n\n').trim() || JSON.stringify(result);
    return result.isError ? `MCP error: ${text}` : text;
}

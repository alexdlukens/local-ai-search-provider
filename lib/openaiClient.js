// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal streaming client for OpenAI-compatible chat completion servers
// (Unsloth Studio, llama.cpp's llama-server, Ollama, LM Studio, ...).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

Gio._promisify(Soup.Session.prototype, 'send_async', 'send_finish');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

const CHAT_PATH = '/chat/completions';
const MODELS_PATH = '/models';

export class ApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ApiError';
    }
}

/**
 * Turn a user-supplied base URL into the root of the OpenAI-compatible API.
 * Accepts "host:port", "http://host:port", ".../v1" or even a full
 * ".../v1/chat/completions" URL.
 */
export function normalizeEndpoint(raw) {
    let value = (raw ?? '').trim();
    if (!value)
        throw new ApiError('No endpoint configured. Set it in AI Search preferences.');

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
        value = `http://${value}`;

    value = value.replace(/\/+$/, '');
    value = value.replace(/\/chat\/completions$/i, '');

    const match = value.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]+)(\/.*)?$/i);
    if (!match)
        throw new ApiError(`Invalid endpoint URL: ${raw}`);

    const origin = match[1];
    let path = match[2] ?? '';
    if (path === '' || path === '/')
        path = '/v1';
    path = path.replace(/\/+$/, '');

    return origin + path;
}

function buildMessage(method, url) {
    const message = Soup.Message.new(method, url);
    if (!message)
        throw new ApiError(`Invalid endpoint URL: ${url}`);
    return message;
}

function applyHeaders(message, apiKey) {
    message.request_headers.append('Accept', 'text/event-stream, application/json');
    message.request_headers.append('User-Agent', 'gnome-ai-search/0.1');
    if (apiKey)
        message.request_headers.append('Authorization', `Bearer ${apiKey}`);
}

function setJsonBody(message, payload) {
    const bytes = new GLib.Bytes(encoder.encode(JSON.stringify(payload)));
    message.set_request_body_from_bytes('application/json', bytes);
}

function statusNumber(message) {
    return message.get_status();
}

function responseContentType(message) {
    try {
        return message.response_headers.get_content_type() ?? '';
    } catch {
        return '';
    }
}

async function readLine(dataStream, cancellable) {
    const result = await dataStream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
    if (!result)
        return null;
    const line = Array.isArray(result) ? result[0] : result;
    if (line === null || line === undefined)
        return null;
    return decoder.decode(line);
}

async function readRemaining(dataStream, cancellable, limit = 32 * 1024) {
    const chunks = [];
    let total = 0;

    while (total < limit) {
        const result = await dataStream.read_bytes_async(
            8192, GLib.PRIORITY_DEFAULT, cancellable);
        if (!result)
            break;
        const bytes = Array.isArray(result) ? result[0] : result;
        if (!bytes || bytes.get_size() === 0)
            break;
        const chunk = bytes.get_data();
        chunks.push(chunk);
        total += chunk.length;
    }

    // GJS's TextDecoder does not support the "stream" option, so decode the
    // complete byte sequence at once.
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
    }
    return decoder.decode(combined).slice(0, limit);
}

function errorDetail(message, body) {
    try {
        const parsed = JSON.parse(body);
        const detail = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
        if (typeof detail === 'string' && detail.trim())
            return detail.trim();
    } catch {
        // Not JSON
    }
    const trimmed = body.trim();
    return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

function accumulateToolCalls(map, deltas) {
    for (const delta of deltas ?? []) {
        const index = delta.index ?? 0;
        let call = map.get(index);
        if (!call) {
            call = {
                id: '',
                type: 'function',
                function: {name: '', arguments: ''},
            };
            map.set(index, call);
        }

        if (delta.id)
            call.id = delta.id;
        if (delta.type)
            call.type = delta.type;
        if (delta.function?.name)
            call.function.name += delta.function.name;
        if (delta.function?.arguments)
            call.function.arguments += delta.function.arguments;
    }
}

function parseToolCalls(value) {
    if (!Array.isArray(value))
        return [];

    // These are already-complete calls from a non-streaming response, so do
    // not merge them by an index they do not have.
    return value.map(call => ({
        id: call.id ?? '',
        type: call.type ?? 'function',
        function: {
            name: call.function?.name ?? '',
            arguments: typeof call.function?.arguments === 'string'
                ? call.function.arguments
                : JSON.stringify(call.function?.arguments ?? {}),
        },
    })).filter(call => call.function.name);
}

function contentFromChunk(json) {
    const choice = json.choices?.[0];
    if (!choice)
        return null;
    return choice.delta ?? choice.message ?? null;
}

export class OpenAIClient {
    constructor() {
        this._session = new Soup.Session({
            timeout: 300,
            idle_timeout: 120,
        });
    }

    destroy() {
        try {
            this._session.abort();
        } catch {
            // Already gone
        }
        this._session = null;
    }

    /**
     * List the models advertised by the server.
     *
     * @returns {Promise<Array<{id: string, loaded: boolean}>>}
     */
    async listModels({baseUrl, apiKey, cancellable}) {
        const message = buildMessage('GET', `${baseUrl}${MODELS_PATH}`);
        applyHeaders(message, apiKey);

        const bytes = await this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, cancellable);
        const status = statusNumber(message);
        const body = decoder.decode(bytes.get_data());

        if (status !== Soup.Status.OK) {
            throw new ApiError(
                `Could not list models (HTTP ${status}): ${errorDetail(message, body)}`);
        }

        let payload;
        try {
            payload = JSON.parse(body);
        } catch {
            throw new ApiError('The model server returned invalid JSON for /models');
        }

        const entries = Array.isArray(payload?.data) ? payload.data : [];
        return entries
            .filter(entry => typeof entry?.id === 'string' && entry.id)
            .map(entry => {
                const status = typeof entry.status?.value === 'string'
                    ? entry.status.value
                    : null;
                let loaded = null;
                if (typeof entry.loaded === 'boolean')
                    loaded = entry.loaded;
                else if (status === 'loaded')
                    loaded = true;
                else if (status === 'unloaded' || status === 'loading')
                    loaded = false;
                return {id: entry.id, status, loaded};
            });
    }

    /**
     * Read the server's current load progress. Only Unsloth Studio implements
     * this route, so a 404/401 (or any other failure) means "not supported".
     *
     * @returns {Promise<{phase: string|null, fraction: number|null,
     *   bytesLoaded: number, bytesTotal: number}|null>}
     */
    async getLoadProgress({baseUrl, apiKey, cancellable}) {
        const message = buildMessage('GET', `${baseUrl}/load-progress`);
        applyHeaders(message, apiKey);

        let bytes;
        try {
            bytes = await this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (e) {
            if (cancellable?.is_cancelled())
                throw e;
            return null;
        }

        if (statusNumber(message) !== Soup.Status.OK)
            return null;

        let payload;
        try {
            payload = JSON.parse(decoder.decode(bytes.get_data()));
        } catch {
            return null;
        }

        if (!payload || typeof payload !== 'object')
            return null;

        const fraction = Number.isFinite(payload.fraction)
            ? Math.min(1, Math.max(0, payload.fraction))
            : null;
        return {
            phase: typeof payload.phase === 'string' ? payload.phase : null,
            fraction,
            bytesLoaded: Number(payload.bytes_loaded) || 0,
            bytesTotal: Number(payload.bytes_total) || 0,
        };
    }

    /**
     * Ask the server which model to use. Used when the Model setting is empty.
     */
    async discoverModel({baseUrl, apiKey, cancellable}) {
        const models = await this.listModels({baseUrl, apiKey, cancellable});
        // Unsloth Studio advertises all downloaded models and marks the loaded
        // one with "loaded": true. Prefer that over an arbitrary first entry.
        const model = models.find(entry => entry.loaded)?.id ??
            models[0]?.id;
        if (!model) {
            throw new ApiError(
                'The model server did not advertise any model. Set the model name in preferences.');
        }
        return model;
    }

    /**
     * Stream a chat completion.
     *
     * Yields:
     *   {type: 'content', text}
     *   {type: 'reasoning', text}
     *   {type: 'done', finishReason, toolCalls}
     */
    async *streamChat({baseUrl, apiKey, model, messages, tools, enableThinking = true, cancellable}) {
        const payload = {
            model,
            messages,
            stream: true,
        };
        if (tools?.length)
            payload.tools = tools;

        // There is no single OpenAI-compatible switch for thinking. Send the
        // forms local servers understand; servers/models without thinking
        // support ignore the extra fields.
        if (enableThinking === false) {
            payload.enable_thinking = false;
            payload.reasoning_effort = 'none';
            payload.chat_template_kwargs = {enable_thinking: false};
        }

        const message = buildMessage('POST', `${baseUrl}${CHAT_PATH}`);
        applyHeaders(message, apiKey);
        setJsonBody(message, payload);

        const inputStream = await this._session.send_async(
            message, GLib.PRIORITY_DEFAULT, cancellable);

        const status = statusNumber(message);
        const contentType = responseContentType(message);

        if (status !== Soup.Status.OK) {
            const dataStream = new Gio.DataInputStream({base_stream: inputStream});
            let body;
            try {
                body = await readRemaining(dataStream, cancellable);
            } finally {
                dataStream.close(null);
            }
            throw new ApiError(
                `Model server error (HTTP ${status}): ${errorDetail(message, body)}`);
        }

        // Some servers ignore "stream": true. Handle a plain JSON response.
        if (contentType.includes('application/json')) {
            const dataStream = new Gio.DataInputStream({base_stream: inputStream});
            let body;
            try {
                body = await readRemaining(dataStream, cancellable, 8 * 1024 * 1024);
            } finally {
                dataStream.close(null);
            }

            let json;
            try {
                json = JSON.parse(body);
            } catch {
                throw new ApiError('The model server returned invalid JSON');
            }

            const messageData = json.choices?.[0]?.message ?? {};
            const reasoning = messageData.reasoning_content ?? messageData.reasoning;
            if (reasoning)
                yield {type: 'reasoning', text: reasoning};
            if (messageData.content)
                yield {type: 'content', text: messageData.content};

            yield {
                type: 'done',
                finishReason: json.choices?.[0]?.finish_reason ?? 'stop',
                toolCalls: parseToolCalls(messageData.tool_calls),
            };
            return;
        }

        const dataStream = new Gio.DataInputStream({base_stream: inputStream});
        const toolCalls = new Map();
        let finishReason = null;
        let sawDone = false;

        try {
            while (!sawDone) {
                let line;
                try {
                    line = await readLine(dataStream, cancellable);
                } catch (e) {
                    if (cancellable.is_cancelled())
                        return;
                    throw e;
                }

                if (line === null)
                    break;

                line = line.replace(/\r$/, '');
                if (!line.startsWith('data:'))
                    continue;

                const data = line.slice(5).trim();
                if (!data)
                    continue;

                if (data === '[DONE]') {
                    sawDone = true;
                    break;
                }

                let json;
                try {
                    json = JSON.parse(data);
                } catch {
                    // Ignore malformed keep-alive/comment frames
                    continue;
                }

                const delta = contentFromChunk(json);
                if (!delta)
                    continue;

                const reasoning = delta.reasoning_content ?? delta.reasoning;
                if (reasoning)
                    yield {type: 'reasoning', text: reasoning};

                if (delta.content)
                    yield {type: 'content', text: delta.content};

                if (delta.tool_calls)
                    accumulateToolCalls(toolCalls, delta.tool_calls);

                if (json.choices?.[0]?.finish_reason)
                    finishReason = json.choices[0].finish_reason;
            }
        } finally {
            dataStream.close(null);
        }

        yield {
            type: 'done',
            finishReason,
            toolCalls: [...toolCalls.entries()]
                .sort(([a], [b]) => a - b)
                .map(([, call]) => call)
                .filter(call => call.function.name),
        };
    }
}

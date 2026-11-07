import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AiResultRow} from './lib/resultView.js';
import {OpenAIClient, normalizeEndpoint, ApiError} from './lib/openaiClient.js';
import {TOOL_DEFINITIONS, executeTool, truncateToolResult} from './lib/tools.js';

const RESULT_ID = 'ai-answer';
const MIN_QUERY_LENGTH = 2;
const FLUSH_INTERVAL_MS = 60;
const MAX_ANSWER_CHARS = 60000;
const MAX_REASONING_CHARS = 24000;

const DEFAULT_SYSTEM_PROMPT =
    'You are an AI assistant embedded in the GNOME Shell overview search. ' +
    'Answer in plain text, concisely, because the answer is displayed in a narrow search result. ' +
    'Avoid Markdown tables and long code blocks. Use the available tools when they help.';

// Search providers without an appInfo are rendered as a grid, which is a poor
// fit for a long streamed answer. A lightweight stand-in gives us the list
// layout (and a provider header with icon) without installing anything.
const EXTENSION_APP_ID = 'org.gnome.Shell.Extensions.desktop';

const AiAppInfo = GObject.registerClass({
    Implements: [Gio.AppInfo],
}, class AiAppInfo extends GObject.Object {
    get_name() {
        return 'AI Search';
    }

    get_display_name() {
        return 'AI Search';
    }

    get_description() {
        return 'AI Search provider';
    }

    get_icon() {
        return Gio.ThemedIcon.new('system-search-symbolic');
    }

    get_id() {
        return EXTENSION_APP_ID;
    }

    get_executable() {
        return '/bin/true';
    }

    get_commandline() {
        return '/bin/true';
    }

    should_show() {
        return true;
    }

    supports_uris() {
        return false;
    }

    supports_files() {
        return false;
    }

    launch(_files, _context) {
        return false;
    }

    launch_uris(_uris, _context) {
    }

    launch_uris_async(_uris, _context, _cancellable, _callback) {
    }

    launch_uris_finish(_result) {
        return false;
    }

    get_supported_types() {
        return [];
    }

    set_as_default_for_type(_contentType) {
    }

    set_as_default_for_extension(_extension) {
    }

    add_supports_type(_contentType) {
    }

    can_remove_supports_type() {
        return false;
    }

    remove_supports_type(_contentType) {
    }

    can_delete() {
        return false;
    }

    do_delete() {
        return false;
    }

    get_show_for_uris() {
        return false;
    }
});

function isCancelled(cancellable) {
    return cancellable?.is_cancelled() ?? false;
}

function isCancellationError(error) {
    if (!error)
        return false;
    try {
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return true;
    } catch {
        // Not a GIO error
    }
    return error.name === 'AbortError' || /cancell/i.test(error.message ?? '');
}

function trimForDisplay(value, limit) {
    if (value.length <= limit)
        return value;
    return `${value.slice(0, limit)}\n…`;
}

export class AiSearchProvider {
    constructor(extension, settings) {
        this._extension = extension;
        this._settings = settings;
        this._appInfo = new AiAppInfo();
        this._client = new OpenAIClient();

        this._query = '';
        this._answer = '';
        this._reasoning = '';
        this._status = '';
        this._error = '';
        this._busy = false;

        this._display = null;
        this._debounceId = 0;
        this._flushId = 0;
        this._serial = 0;
        this._requestCancellable = null;
        this._shellCancellable = null;
        this._shellCancellableId = 0;
        this._destroyed = false;
    }

    get id() {
        return 'ai-search';
    }

    get appInfo() {
        return this._appInfo;
    }

    get isRemoteProvider() {
        return false;
    }

    get canLaunchSearch() {
        return true;
    }

    get maxResults() {
        return 1;
    }

    // --- Search provider API -------------------------------------------------

    getInitialResultSet(terms, cancellable) {
        if (this._destroyed)
            return [];

        const query = terms.join(' ').trim();
        this._cancelWork();
        this._resetState(query);

        if (query.length < MIN_QUERY_LENGTH)
            return [];

        this._watchShellCancellable(cancellable);
        this._scheduleRequest();
        return [RESULT_ID];
    }

    getSubsearchResultSet(_previousResults, terms, cancellable) {
        return this.getInitialResultSet(terms, cancellable);
    }

    async getResultMetas(ids, _cancellable) {
        return ids.map(id => ({
            id,
            name: 'AI Search',
            description: '',
            createIcon: size => new St.Icon({
                icon_name: 'system-search-symbolic',
                icon_size: size,
            }),
        }));
    }

    createResultObject(_meta) {
        const row = new AiResultRow(this);
        row.connect('destroy', () => {
            if (this._display === row)
                this._display = null;
        });
        this._display = row;
        this._render();
        return row;
    }

    filterResults(results, max) {
        return results.slice(0, max);
    }

    activateResult(_id, _terms) {
        this.copyAnswer();
    }

    launchSearch() {
        this._extension.openPreferences();
    }

    copyAnswer() {
        const text = this._answer.trim();
        if (!text) {
            Main.notify('AI Search',
                this._error || 'There is no answer to copy yet.');
            return;
        }

        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        Main.notify('AI Search', 'Answer copied to clipboard.');
    }

    destroy() {
        this._destroyed = true;
        this._cancelWork();
        this._client.destroy();
        this._client = null;
        this._display = null;
        this._settings = null;
        this._extension = null;
    }

    // --- Request lifecycle ---------------------------------------------------

    _watchShellCancellable(cancellable) {
        if (!cancellable)
            return;
        this._shellCancellable = cancellable;
        this._shellCancellableId = cancellable.connect(() => {
            this._shellCancellable = null;
            this._shellCancellableId = 0;
            this._cancelWork(false);
        });
    }

    _cancelWork(disconnectShell = true) {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
        if (this._flushId) {
            GLib.source_remove(this._flushId);
            this._flushId = 0;
        }
        if (this._requestCancellable) {
            this._requestCancellable.cancel();
            this._requestCancellable = null;
        }
        if (this._shellCancellable) {
            if (disconnectShell) {
                try {
                    this._shellCancellable.disconnect(this._shellCancellableId);
                } catch {
                    // Cancellable is already gone
                }
            }
            this._shellCancellable = null;
            this._shellCancellableId = 0;
        }
    }

    _resetState(query) {
        this._query = query;
        this._answer = '';
        this._reasoning = '';
        this._status = '';
        this._error = '';
        this._busy = false;
        this._render();
    }

    _scheduleRequest() {
        const delay = Math.max(0, this._settings.get_int('debounce-ms'));
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._debounceId = 0;
            this._startRequest().catch(logError);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _startRequest() {
        if (this._destroyed)
            return;

        const serial = ++this._serial;
        const cancellable = new Gio.Cancellable();
        this._requestCancellable = cancellable;
        this._busy = true;
        this._setStatus('Thinking…');

        try {
            const baseUrl = normalizeEndpoint(this._settings.get_string('endpoint'));
            const apiKey = this._settings.get_string('api-key').trim();
            const model = await this._resolveModel(baseUrl, apiKey, cancellable);
            if (serial !== this._serial)
                return;

            const showReasoning = this._settings.get_boolean('show-reasoning');
            const toolsEnabled = this._settings.get_boolean('enable-tools');
            const maxRounds = Math.max(0, this._settings.get_int('max-tool-rounds'));
            const messages = this._buildMessages();

            let round = 0;
            while (true) {
                const roundContent = {text: ''};
                const toolCalls = [];
                let firstReasoningChunk = true;

                for await (const event of this._client.streamChat({
                    baseUrl,
                    apiKey,
                    model,
                    messages,
                    tools: toolsEnabled ? TOOL_DEFINITIONS : null,
                    cancellable,
                })) {
                    if (serial !== this._serial || cancellable.is_cancelled())
                        return;

                    switch (event.type) {
                    case 'content':
                        roundContent.text += event.text;
                        if (this._answer.length < MAX_ANSWER_CHARS) {
                            this._answer += event.text;
                            this._scheduleFlush();
                        }
                        this._setStatus('Responding…');
                        break;
                    case 'reasoning':
                        if (showReasoning && this._reasoning.length < MAX_REASONING_CHARS) {
                            if (firstReasoningChunk && this._reasoning.trim())
                                this._reasoning += '\n\n';
                            this._reasoning += event.text;
                            this._scheduleFlush();
                        }
                        firstReasoningChunk = false;
                        this._setStatus('Thinking…');
                        break;
                    case 'done':
                        for (const call of event.toolCalls)
                            toolCalls.push(call);
                        break;
                    }
                }

                if (serial !== this._serial || cancellable.is_cancelled())
                    return;

                if (toolCalls.length === 0) {
                    if (!this._answer.trim())
                        this._answer = '(The model returned an empty answer.)';
                    break;
                }

                if (!toolsEnabled) {
                    this._answer += `${this._answer ? '\n\n' : ''}` +
                        '(The model requested a tool, but tools are disabled in preferences.)';
                    break;
                }

                if (round >= maxRounds) {
                    this._answer += `${this._answer ? '\n\n' : ''}` +
                        '(Tool call limit reached.)';
                    break;
                }

                round += 1;
                const normalized = toolCalls.map((call, index) => ({
                    id: call.id || `call_${round}_${index}`,
                    type: 'function',
                    function: {
                        name: call.function.name,
                        arguments: call.function.arguments || '{}',
                    },
                }));

                messages.push({
                    role: 'assistant',
                    content: roundContent.text || null,
                    tool_calls: normalized,
                });

                for (const call of normalized) {
                    if (serial !== this._serial || cancellable.is_cancelled())
                        return;
                    this._setStatus(`Running ${call.function.name}…`);
                    let result;
                    try {
                        result = await executeTool(
                            call.function.name, call.function.arguments);
                    } catch (e) {
                        result = `Tool error: ${e.message}`;
                    }
                    messages.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        content: truncateToolResult(result),
                    });
                }

                this._setStatus('Thinking…');
                this._flushNow();
            }

            this._setStatus(this._answer.trim() ? 'Press Enter to copy' : '');
        } catch (e) {
            if (serial !== this._serial || isCancelled(cancellable) || isCancellationError(e))
                return;
            this._error = e instanceof ApiError ? e.message : (e.message ?? String(e));
            this._setStatus('Error');
        } finally {
            if (serial === this._serial) {
                this._busy = false;
                this._requestCancellable = null;
                this._flushNow();
            }
        }
    }

    _buildMessages() {
        const messages = [];
        const prompt = this._settings.get_string('system-prompt').trim() ||
            DEFAULT_SYSTEM_PROMPT;
        messages.push({role: 'system', content: prompt});
        messages.push({role: 'user', content: this._query});
        return messages;
    }

    async _resolveModel(baseUrl, apiKey, cancellable) {
        const configured = this._settings.get_string('model').trim();
        if (configured)
            return configured;

        return this._client.discoverModel({baseUrl, apiKey, cancellable});
    }

    // --- Display -------------------------------------------------------------

    _setStatus(status) {
        if (this._status === status)
            return;
        this._status = status;
        this._render();
    }

    _scheduleFlush() {
        if (this._flushId)
            return;
        this._flushId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, FLUSH_INTERVAL_MS, () => {
                this._flushId = 0;
                this._render();
                return GLib.SOURCE_REMOVE;
            });
    }

    _flushNow() {
        if (this._flushId) {
            GLib.source_remove(this._flushId);
            this._flushId = 0;
        }
        this._render();
    }

    _render() {
        if (!this._display || this._destroyed)
            return;

        this._display.update({
            answer: trimForDisplay(this._answer, MAX_ANSWER_CHARS),
            reasoning: trimForDisplay(this._reasoning, MAX_REASONING_CHARS),
            status: this._status,
            busy: this._busy,
            error: this._error,
            showReasoning: this._settings.get_boolean('show-reasoning'),
        });
    }
}

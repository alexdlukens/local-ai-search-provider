// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AiResultRow, AiHistoryRow} from './lib/resultView.js';
import {OpenAIClient, normalizeEndpoint, ApiError} from './lib/openaiClient.js';
import {runChat, buildMessages} from './lib/chatEngine.js';
import {buildToolRegistry} from './lib/toolRegistry.js';
import {ChatStore, titleFor} from './lib/chatStore.js';
import {ModelWatch, formatModelState} from './lib/modelWatch.js';
import {launchChatWindow} from './lib/launch.js';

const RESULT_ID = 'ai-answer';
const HISTORY_RESULT_ID = 'ai-chat-history';
const MIN_QUERY_LENGTH = 2;
const FLUSH_INTERVAL_MS = 60;
const MAX_ANSWER_CHARS = 60000;
const MAX_REASONING_CHARS = 24000;
const LAUNCH_GUARD_MS = 600;

const EXTENSION_DIR = GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0]);

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

function startOfToday() {
    const now = GLib.DateTime.new_now_local();
    return GLib.DateTime.new_local(
        now.get_year(), now.get_month(), now.get_day_of_month(),
        0, 0, 0).to_unix() * 1000;
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
        this._store = new ChatStore();

        this._query = '';
        this._answer = '';
        this._reasoning = '';
        this._status = '';
        this._error = '';
        this._busy = false;
        this._metrics = null;
        this._conversation = null;
        this._turnFinalized = false;
        this._reasoningActive = false;

        this._display = null;
        this._debounceId = 0;
        this._flushId = 0;
        this._serial = 0;
        this._requestCancellable = null;
        this._preloadCancellable = null;
        this._shellCancellable = null;
        this._shellCancellableId = 0;
        this._modelWatch = null;
        this._lastLaunch = 0;
        this._destroyed = false;
        this._searchController = null;
        this._searchActiveId = 0;

        this._watchSearchState();
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
        return 2;
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

        const results = [RESULT_ID, HISTORY_RESULT_ID];
        return results;
    }

    getSubsearchResultSet(_previousResults, terms, cancellable) {
        return this.getInitialResultSet(terms, cancellable);
    }

    async getResultMetas(ids, _cancellable) {
        const conversations = this._store?.list() ?? [];
        const since = startOfToday();
        const todayCount = conversations.filter(
            conversation => conversation.updated >= since).length;
        const description = conversations.length === 0
            ? 'No saved chats yet'
            : (todayCount === 1 ? '1 chat today' : `${todayCount} chats today`);

        return ids.map(id => {
            if (id === HISTORY_RESULT_ID) {
                return {
                    id,
                    name: 'AI chat history',
                    description,
                    createIcon: size => new St.Icon({
                        icon_name: 'document-open-recent-symbolic',
                        icon_size: size,
                    }),
                };
            }

            return {
                id,
                name: 'AI Search',
                description: '',
                createIcon: size => new St.Icon({
                    icon_name: 'system-search-symbolic',
                    icon_size: size,
                }),
            };
        });
    }

    createResultObject(meta) {
        if (meta?.id === HISTORY_RESULT_ID)
            return new AiHistoryRow(this, meta.description ?? '');

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

    activateResult(id, _terms) {
        if (id === HISTORY_RESULT_ID)
            this.openChatHistory();
        else
            this.openChat();
    }

    launchSearch() {
        this._extension.openPreferences();
    }

    /**
     * Open the current answer in the chat window so it can be continued.
     */
    openChat() {
        if (this._destroyed)
            return;
        if (!this._guardLaunch())
            return;

        this._cancelWork();
        this._stopModelWatch();
        this._finalizeConversation(Boolean(this._conversation));
        this._busy = false;

        const id = this._conversation?.id;
        if (!id) {
            Main.notify('AI Search', 'Ask a question first.');
            return;
        }

        // If the debounce had not fired (or the answer was still streaming
        // with nothing received yet), the saved conversation ends on the
        // user's question. Ask the chat window to answer it there.
        const resume = this._conversation.messages.at(-1)?.role === 'user';

        try {
            launchChatWindow(EXTENSION_DIR, {conversationId: id, resume});
            if (Main.overview?.visible)
                Main.overview.hide();
        } catch (e) {
            Main.notify('AI Search', `Could not open the chat window: ${e.message}`);
        }
    }

    openChatHistory() {
        if (this._destroyed)
            return;
        if (!this._guardLaunch())
            return;

        this._cancelWork();
        this._stopModelWatch();
        this._finalizeConversation(false);
        this._busy = false;

        try {
            launchChatWindow(EXTENSION_DIR, {history: true});
            if (Main.overview?.visible)
                Main.overview.hide();
        } catch (e) {
            Main.notify('AI Search', `Could not open the chat window: ${e.message}`);
        }
    }

    destroy() {
        this._destroyed = true;
        this._cancelWork();
        this._stopModelWatch();
        this._finalizeConversation(false);
        if (this._searchController && this._searchActiveId) {
            try {
                this._searchController.disconnect(this._searchActiveId);
            } catch {
                // The controller is already gone
            }
        }
        this._searchController = null;
        this._searchActiveId = 0;
        this._store?.destroy();
        this._store = null;
        if (this._preloadCancellable) {
            this._preloadCancellable.cancel();
            this._preloadCancellable = null;
        }
        this._client.destroy();
        this._client = null;
        this._display = null;
        this._settings = null;
        this._extension = null;
    }

    // --- Request lifecycle ---------------------------------------------------

    _guardLaunch() {
        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastLaunch < LAUNCH_GUARD_MS)
            return false;
        this._lastLaunch = now;
        return true;
    }

    _watchSearchState() {
        this._searchController = Main.overview?.searchController ?? null;
        if (!this._searchController)
            return;

        this._searchActiveId = this._searchController.connect(
            'notify::search-active', () => this._onSearchActiveChanged());
        if (this._searchController.searchActive)
            this._onSearchActiveChanged();
    }

    _onSearchActiveChanged() {
        if (this._destroyed)
            return;

        if (this._searchController?.searchActive) {
            // Start loading a cold model as soon as the search opens instead
            // of waiting for the typing debounce.
            this._preloadModel().catch(logError);
            return;
        }

        this._abandonSearch();
    }

    /**
     * Warm the configured model without sending a user query.
     *
     * Best-effort: a failure here is left for the real request to report, and
     * a preload already in flight is kept because it may finish loading the
     * model for the next query.
     */
    async _preloadModel() {
        if (this._destroyed || !this._client || this._busy ||
            this._preloadCancellable)
            return;

        const cancellable = new Gio.Cancellable();
        this._preloadCancellable = cancellable;
        try {
            const baseUrl = normalizeEndpoint(
                this._settings.get_string('endpoint'));
            const apiKey = this._settings.get_string('api-key').trim();
            const model = this._settings.get_string('model').trim();
            await this._client.preloadModel({
                baseUrl, apiKey, model, cancellable,
            });
        } catch {
            // The search request path reports real connection or config
            // errors; a background warm-up should stay silent.
        } finally {
            if (this._preloadCancellable === cancellable)
                this._preloadCancellable = null;
        }
    }

    // The user left the shell search (closed the overview, opened the app
    // grid, launched another result, ...) without opening this answer. Stop
    // the request and drop the turn so it never reaches saved chat history.
    _abandonSearch() {
        if (!this._conversation || this._turnFinalized)
            return;

        this._cancelWork();
        this._stopModelWatch();
        this._serial += 1;
        this._busy = false;
        this._conversation = null;
        this._answer = '';
        this._reasoning = '';
        this._reasoningActive = false;
        this._metrics = null;
        this._status = '';
        this._error = '';
        this._render();
    }

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
        // Keep a partial answer if the user typed a new query mid-stream.
        this._finalizeConversation(false);
        this._stopModelWatch();
        this._serial += 1;

        this._query = query;
        this._answer = '';
        this._reasoning = '';
        this._reasoningActive = false;
        this._metrics = null;
        this._status = '';
        this._error = '';
        this._busy = false;
        this._turnFinalized = false;
        this._conversation = query
            ? {
                id: GLib.uuid_string_random(),
                title: titleFor(query),
                created: Date.now(),
                updated: Date.now(),
                messages: [{role: 'user', content: query, ts: Date.now()}],
            }
            : null;
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
        if (this._destroyed || !this._conversation)
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

            const enableThinking = this._settings.get_boolean('enable-thinking');
            const toolsEnabled = this._settings.get_boolean('enable-tools');
            const maxRounds = Math.max(0, this._settings.get_int('max-tool-rounds'));
            let registry = {
                definitions: [],
                execute: null,
                warnings: [],
            };

            if (toolsEnabled) {
                if (this._settings.get_boolean('enable-mcp'))
                    this._setStatus('Loading tools…');
                registry = await buildToolRegistry(this._settings, {
                    cancellable,
                    onStatus: text => {
                        if (serial === this._serial)
                            this._setStatus(text);
                    },
                });
                if (serial !== this._serial)
                    return;
                if (registry.warnings.length)
                    log(`AI Search MCP: ${registry.warnings.join('; ')}`);
                if (this._settings.get_boolean('enable-mcp'))
                    this._setStatus('Thinking…');
            }

            this._startModelWatch(serial, baseUrl, apiKey, model, cancellable);

            const messages = buildMessages(
                this._settings.get_string('system-prompt'),
                this._conversation.messages);

            for await (const event of runChat({
                client: this._client,
                baseUrl,
                apiKey,
                model,
                messages,
                tools: registry.definitions.length ? registry.definitions : null,
                execute: registry.execute ?? undefined,
                enableThinking,
                maxToolRounds: maxRounds,
                cancellable,
            })) {
                if (serial !== this._serial || cancellable.is_cancelled())
                    return;

                switch (event.type) {
                case 'content':
                    this._appendAnswer(event.text);
                    this._reasoningActive = false;
                    this._stopModelWatch();
                    this._setStatus('Responding…');
                    break;
                case 'reasoning':
                    this._appendReasoning(event.text);
                    this._setStatus('Thinking…');
                    break;
                case 'status':
                    this._reasoningActive = false;
                    this._setStatus(event.text);
                    break;
                case 'notice':
                    this._appendNotice(event.text);
                    break;
                case 'metrics':
                    this._metrics = event.metrics;
                    this._scheduleFlush();
                    break;
                }
            }

            if (serial !== this._serial || cancellable.is_cancelled())
                return;

            this._finalizeConversation(true);
            this._setStatus('Enter to open chat');
        } catch (e) {
            if (serial !== this._serial || isCancelled(cancellable) || isCancellationError(e))
                return;
            this._error = e instanceof ApiError ? e.message : (e.message ?? String(e));
            this._setStatus('Error');
        } finally {
            if (serial === this._serial) {
                this._busy = false;
                this._requestCancellable = null;
                this._stopModelWatch();
                this._flushNow();
            }
        }
    }

    _resolveModel(baseUrl, apiKey, cancellable) {
        const configured = this._settings.get_string('model').trim();
        if (configured)
            return configured;

        return this._client.discoverModel({baseUrl, apiKey, cancellable});
    }

    _startModelWatch(serial, baseUrl, apiKey, model, cancellable) {
        this._stopModelWatch();
        if (!model)
            return;

        const watch = new ModelWatch({
            client: this._client,
            baseUrl,
            apiKey,
            model,
            cancellable,
            onUpdate: state => {
                if (this._destroyed || serial !== this._serial)
                    return;
                if (state.loading) {
                    const text = formatModelState(state);
                    if (text)
                        this._setStatus(text);
                } else if (this._status.startsWith('Loading model')) {
                    this._setStatus('Thinking…');
                }
            },
        });
        this._modelWatch = watch;
        watch.start();
    }

    _stopModelWatch() {
        if (this._modelWatch) {
            this._modelWatch.stop();
            this._modelWatch = null;
        }
    }

    _finalizeConversation(force) {
        if (!this._conversation || this._turnFinalized)
            return;

        const answer = this._answer.trim();
        if (!answer && !force)
            return;

        this._turnFinalized = true;
        if (answer) {
            this._conversation.messages.push({
                role: 'assistant',
                content: this._answer,
                metrics: this._metrics,
            });
        }
        this._store?.upsert(this._conversation);
    }

    // --- Display -------------------------------------------------------------

    _appendAnswer(text) {
        if (!text || this._answer.length >= MAX_ANSWER_CHARS)
            return;
        const remaining = MAX_ANSWER_CHARS - this._answer.length;
        this._answer += text.length > remaining ? text.slice(0, remaining) : text;
        this._scheduleFlush();
    }

    _appendNotice(text) {
        this._appendAnswer(`${this._answer ? '\n\n' : ''}${text}`);
    }

    _appendReasoning(text) {
        if (!text || !this._settings.get_boolean('show-reasoning'))
            return;
        if (this._reasoning.length >= MAX_REASONING_CHARS)
            return;

        if (!this._reasoningActive && this._reasoning.trim()) {
            this._reasoning += '\n\n';
        }
        this._reasoningActive = true;

        const remaining = MAX_REASONING_CHARS - this._reasoning.length;
        this._reasoning += text.length > remaining ? text.slice(0, remaining) : text;
        this._scheduleFlush();
    }

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
            metrics: this._metrics,
        });
    }
}

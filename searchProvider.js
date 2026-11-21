// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AiResultRow, AiHistoryRow} from './lib/resultView.js';
import {ChatStore, titleFor} from './lib/chatStore.js';
import {launchChatWindow} from './lib/launch.js';

const RESULT_ID = 'ai-answer';
const HISTORY_RESULT_ID = 'ai-chat-history';
const MIN_QUERY_LENGTH = 2;
const LAUNCH_GUARD_MS = 600;

const EXTENSION_DIR = GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0]);

// Search providers without an appInfo are rendered as a grid, which is a poor
// fit for a wide row. A lightweight stand-in gives us the list layout (and a
// provider header with icon) without installing anything. It reports the
// extension's own id rather than borrowing another app's.
const EXTENSION_APP_ID = 'ai-search@alexdlukens.github.io';

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

    launch_uris_async(_uris, _context, _cancellable, callback) {
        callback(this, null);
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

function startOfToday() {
    const now = GLib.DateTime.new_now_local();
    return GLib.DateTime.new_local(
        now.get_year(), now.get_month(), now.get_day_of_month(),
        0, 0, 0).to_unix() * 1000;
}

export class AiSearchProvider {
    constructor(extension) {
        this._extension = extension;
        this._appInfo = new AiAppInfo();
        this._store = new ChatStore();

        this._conversation = null;
        this._status = '';

        this._display = null;
        this._lastLaunch = 0;
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
        return 2;
    }

    // --- Search provider API -------------------------------------------------

    getInitialResultSet(terms, _cancellable) {
        if (this._destroyed)
            return [];

        const query = terms.join(' ').trim();
        this._conversation = query.length < MIN_QUERY_LENGTH ? null : {
            id: GLib.uuid_string_random(),
            title: titleFor(query),
            created: Date.now(),
            updated: Date.now(),
            messages: [{role: 'user', content: query, ts: Date.now()}],
        };
        this._status = this._conversation ? 'Press Enter to open chat' : '';
        this._render();

        return this._conversation ? [RESULT_ID, HISTORY_RESULT_ID] : [];
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
                description: 'Open the chat window; the model loads there.',
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
     * Hand the pending question to the chat window, which loads the model and
     * answers it there.
     */
    openChat() {
        if (this._destroyed)
            return;
        if (!this._guardLaunch())
            return;

        const conversation = this._conversation;
        if (!conversation) {
            Main.notify('AI Search', 'Ask a question first.');
            return;
        }

        this._store?.upsert(conversation);

        try {
            launchChatWindow(EXTENSION_DIR, {
                conversationId: conversation.id,
                resume: true,
            });
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
        this._store?.destroy();
        this._store = null;
        if (this._display) {
            this._display.destroy();
            this._display = null;
        }
        this._conversation = null;
        this._extension = null;
    }

    _guardLaunch() {
        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastLaunch < LAUNCH_GUARD_MS)
            return false;
        this._lastLaunch = now;
        return true;
    }

    _render() {
        if (!this._display || this._destroyed)
            return;
        this._display.update({status: this._status});
    }
}

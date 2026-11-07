// SPDX-License-Identifier: GPL-3.0-or-later
// Persistent chat history shared by the shell search provider and the chat
// window process. The JSON file is small, so reads are cached until a file
// monitor reports an external change.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MAX_CONVERSATIONS = 100;
const TITLE_CHARS = 64;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export function titleFor(text) {
    const line = String(text ?? '').split('\n')
        .map(part => part.trim())
        .find(Boolean) ?? 'New chat';
    const compact = line.replace(/\s+/g, ' ');
    if (compact.length <= TITLE_CHARS)
        return compact;
    return `${compact.slice(0, TITLE_CHARS - 1)}…`;
}

function now() {
    return Date.now();
}

function defaultPath() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'ai-search', 'chats.json']);
}

export class ChatStore {
    constructor({path = defaultPath()} = {}) {
        this._path = path;
        this._dir = GLib.path_get_dirname(path);
        this._conversations = null;
        this._monitor = null;
        this._destroyed = false;
        this._ensureMonitor();
    }

    get path() {
        return this._path;
    }

    create(userText) {
        const created = now();
        return {
            id: GLib.uuid_string_random(),
            title: titleFor(userText),
            created,
            updated: created,
            messages: [],
        };
    }

    list() {
        return this._load().slice();
    }

    get(id) {
        return this._load().find(conversation => conversation.id === id) ?? null;
    }

    upsert(conversation) {
        if (!conversation?.id)
            return;

        conversation.updated = now();
        const conversations = this._load()
            .filter(item => item.id !== conversation.id);
        conversations.unshift(conversation);
        this._conversations = conversations
            .sort((a, b) => b.updated - a.updated)
            .slice(0, MAX_CONVERSATIONS);
        this._save();
    }

    remove(id) {
        const before = this._load().length;
        this._conversations = this._load().filter(item => item.id !== id);
        if (this._conversations.length !== before)
            this._save();
    }

    destroy() {
        this._destroyed = true;
        if (this._monitor) {
            try {
                this._monitor.cancel();
            } catch {
                // Already gone
            }
            this._monitor = null;
        }
    }

    _load() {
        if (this._conversations)
            return this._conversations;

        let raw = null;
        try {
            const [ok, contents] = GLib.file_get_contents(this._path);
            if (ok)
                raw = JSON.parse(decoder.decode(contents));
        } catch {
            raw = null;
        }

        this._conversations = this._normalize(raw);
        return this._conversations;
    }

    _normalize(raw) {
        const conversations = [];
        const entries = Array.isArray(raw?.conversations) ? raw.conversations : [];

        for (const entry of entries) {
            if (typeof entry?.id !== 'string' || !entry.id)
                continue;

            const messages = (Array.isArray(entry.messages) ? entry.messages : [])
                .filter(message =>
                    message &&
                    (message.role === 'user' || message.role === 'assistant') &&
                    typeof message.content === 'string' &&
                    message.content.trim())
                .map(message => ({
                    role: message.role,
                    content: message.content,
                    ...(message.metrics && typeof message.metrics === 'object'
                        ? {metrics: message.metrics}
                        : {}),
                }));

            if (messages.length === 0)
                continue;

            conversations.push({
                id: entry.id,
                title: typeof entry.title === 'string' && entry.title.trim()
                    ? entry.title
                    : titleFor(messages[0].content),
                created: Number(entry.created) || 0,
                updated: Number(entry.updated) || 0,
                messages,
            });
        }

        return conversations
            .sort((a, b) => b.updated - a.updated)
            .slice(0, MAX_CONVERSATIONS);
    }

    _save() {
        if (this._destroyed)
            return;

        try {
            GLib.mkdir_with_parents(this._dir, 0o700);
            const payload = {
                version: 1,
                conversations: this._conversations ?? [],
            };
            const temporary = `${this._path}.tmp`;
            GLib.file_set_contents(temporary, encoder.encode(JSON.stringify(payload)));
            Gio.File.new_for_path(temporary).move(
                Gio.File.new_for_path(this._path),
                Gio.FileCopyFlags.OVERWRITE,
                null,
                null);
        } catch (e) {
            logError(e);
        }
    }

    _ensureMonitor() {
        try {
            this._monitor = Gio.File.new_for_path(this._path)
                .monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => {
                if (!this._destroyed)
                    this._conversations = null;
            });
        } catch {
            this._monitor = null;
        }
    }
}

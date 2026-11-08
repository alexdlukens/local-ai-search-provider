// SPDX-License-Identifier: GPL-3.0-or-later
// Standalone chat window, launched from the overview result. Runs in its own
// process so GTK never shares a main loop with the shell's Clutter loop.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import {OpenAIClient, normalizeEndpoint} from './lib/openaiClient.js';
import {runChat, buildMessages} from './lib/chatEngine.js';
import {buildToolRegistry} from './lib/toolRegistry.js';
import {ChatStore, titleFor} from './lib/chatStore.js';
import {ModelWatch, formatModelState} from './lib/modelWatch.js';
import {parseMarkdown, escapeMarkup, inlineToPango} from './lib/markdown.js';
import {formatMetrics} from './lib/metrics.js';

const UUID = 'ai-search@alexdlukens.github.io';
const SCHEMA_ID = 'org.gnome.shell.extensions.ai-search';
const APP_ID = 'org.gnome.Shell.Extensions.AiSearch.Chat';
const FLUSH_INTERVAL_MS = 60;
const MAX_ANSWER_CHARS = 60000;
const MAX_REASONING_CHARS = 24000;
const EXTENSION_DIR = GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0]);

let cssInstalled = false;

function installCss() {
    if (cssInstalled)
        return;
    cssInstalled = true;

    const display = Gdk.Display.get_default();
    if (!display)
        return;

    const provider = new Gtk.CssProvider();
    provider.load_from_string(`
        .ai-chat-user {
            background-color: @accent_bg_color;
            color: @accent_fg_color;
            border-radius: 14px;
            padding: 8px 12px;
        }
        .ai-chat-assistant {
            padding: 2px 0;
        }
        .ai-chat-reasoning {
            font-style: italic;
            font-size: 0.92em;
        }
        .ai-chat-status {
            font-size: 0.9em;
        }
        .ai-chat-metrics {
            font-size: 0.85em;
        }
        .ai-chat-tool {
            background-color: @card_bg_color;
            border-radius: 8px;
            padding: 4px 8px;
        }
        .ai-chat-history-title {
            font-weight: bold;
        }
        .ai-chat-history-heading {
            font-weight: bold;
            font-size: 1.1em;
        }
        .ai-chat-timestamp {
            font-size: 0.8em;
        }
        .ai-chat-code {
            background-color: @card_bg_color;
            border-radius: 8px;
            padding: 8px 10px;
        }
        .ai-chat-code-text {
            font-family: monospace;
        }
        .ai-chat-code-lang {
            font-size: 0.85em;
        }
        .ai-chat-quote {
            border-left: 3px solid @accent_bg_color;
            padding-left: 10px;
            opacity: 0.9;
        }
        .ai-chat-table {
            background-color: @card_bg_color;
            border-radius: 8px;
            padding: 10px 12px;
        }
        .ai-chat-table-header {
            font-weight: bold;
        }
        .ai-chat-list-marker {
            min-width: 18px;
        }
    `);
    Gtk.StyleContext.add_provider_for_display(
        display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

function loadSettings() {
    const schemaDir = GLib.build_filenamev([EXTENSION_DIR, 'schemas']);
    const source = Gio.SettingsSchemaSource.new_from_directory(
        schemaDir, Gio.SettingsSchemaSource.get_default(), false);
    const schema = source?.lookup(SCHEMA_ID, false);
    if (!schema)
        throw new Error(`Settings schema ${SCHEMA_ID} not found in ${schemaDir}`);
    return Gio.Settings.new_full(schema, null, null);
}

function parseArgs(args) {
    let conversationId = null;
    let history = false;
    let resume = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--history') {
            history = true;
        } else if (args[i] === '--continue') {
            resume = true;
        } else if (args[i] === '--conversation') {
            conversationId = args[i + 1] ?? null;
            i += 1;
        }
    }

    return {conversationId, history, resume};
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

function formatDate(ms) {
    if (!ms)
        return '';
    return GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000))
        .format('%b %-e, %H:%M');
}

function previewOf(conversation) {
    const last = conversation.messages.at(-1)?.content ?? '';
    const compact = last.replace(/\s+/g, ' ').trim();
    return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact;
}

function toolLabel(name) {
    const value = String(name ?? 'tool');
    if (value.startsWith('mcp__')) {
        const parts = value.split('__').filter(Boolean);
        const server = (parts[1] ?? 'MCP').replace(/_/g, ' ');
        const tool = parts.slice(2).join('_').replace(/_/g, ' ');
        return `${server} · ${tool}`;
    }
    const words = value.replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

class ChatWindow {
    constructor(app, settings, store) {
        this._app = app;
        this._settings = settings;
        this._store = store;
        this._client = new OpenAIClient();

        this._conversation = null;
        this._current = null;
        this._cancellable = null;
        this._modelWatch = null;
        this._busy = false;
        this._renderId = 0;
        this._scrollId = 0;
        this._copyId = 0;
        this._emptyState = null;
        this._settingsIds = [];

        installCss();
        this._buildUi();
        this._installActions();

        this._window.connect('close-request', () => {
            this._shutdown();
            return false;
        });
    }

    get window() {
        return this._window;
    }

    open({conversationId, history, resume = false}) {
        if (history)
            this.showHistory();
        else if (conversationId) {
            this.showConversation(conversationId);
            if (resume)
                this._resumeIfNeeded();
        } else if (!this._conversation)
            this.newChat();
    }

    _resumeIfNeeded() {
        if (this._busy || !this._conversation)
            return;
        if (this._conversation.messages.at(-1)?.role !== 'user')
            return;
        this._respond().catch(logError);
    }

    // --- UI construction -----------------------------------------------------

    _buildUi() {
        this._window = new Adw.ApplicationWindow({
            application: this._app,
            title: 'AI Chat',
            default_width: 760,
            default_height: 820,
        });

        const toolbar = new Adw.ToolbarView();
        this._window.set_content(toolbar);

        const header = new Adw.HeaderBar();
        toolbar.add_top_bar(header);

        this._backButton = new Gtk.Button({
            icon_name: 'go-previous-symbolic',
            tooltip_text: 'Back to chat',
            visible: false,
        });
        this._backButton.connect('clicked', () => this._showChat());
        header.pack_start(this._backButton);

        this._title = new Adw.WindowTitle({title: 'AI Chat', subtitle: ''});
        header.set_title_widget(this._title);

        const menuButton = new Gtk.MenuButton({
            icon_name: 'open-menu-symbolic',
            tooltip_text: 'Menu',
        });
        const menu = new Gio.Menu();
        menu.append('Enable thinking', 'win.thinking');
        menu.append('Show reasoning', 'win.show-reasoning');
        menu.append('Preferences', 'win.preferences');
        menuButton.set_menu_model(menu);
        header.pack_end(menuButton);

        const newButton = new Gtk.Button({
            icon_name: 'document-new-symbolic',
            tooltip_text: 'New chat',
        });
        newButton.connect('clicked', () => this.newChat());
        header.pack_end(newButton);

        const historyButton = new Gtk.Button({
            icon_name: 'document-open-recent-symbolic',
            tooltip_text: 'Chat history',
        });
        historyButton.connect('clicked', () => this.showHistory());
        header.pack_end(historyButton);

        this._stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 120,
        });
        toolbar.set_content(this._stack);

        this._buildChatPage();
        this._buildHistoryPage();

        // Escape returns from history, then closes the window.
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_controller, keyval) => {
            if (keyval !== Gdk.KEY_Escape)
                return false;
            if (this._stack.visible_child_name === 'history')
                this._showChat();
            else
                this._window.close();
            return true;
        });
        this._window.add_controller(keys);
    }

    _buildChatPage() {
        const page = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});

        this._chatScroller = new Gtk.ScrolledWindow({
            vexpand: true,
            hexpand: true,
        });
        this._chatScroller.set_policy(
            Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);

        this._messagesBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 18,
            margin_bottom: 18,
            margin_start: 18,
            margin_end: 18,
        });
        this._chatScroller.set_child(this._messagesBox);
        page.append(this._chatScroller);

        const footer = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_start: 18,
            margin_end: 18,
            margin_bottom: 14,
        });

        const statusRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });
        this._spinner = new Gtk.Spinner({
            visible: false,
            spinning: false,
            valign: Gtk.Align.CENTER,
        });
        statusRow.append(this._spinner);

        this._statusLabel = new Gtk.Label({
            xalign: 0,
            wrap: true,
            visible: false,
            hexpand: true,
        });
        this._statusLabel.add_css_class('ai-chat-status');
        this._statusLabel.set_opacity(0.75);
        statusRow.append(this._statusLabel);
        footer.append(statusRow);

        const composer = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });
        this._entry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: 'Ask a follow-up…',
        });
        this._entry.connect('activate', () => this._send());
        composer.append(this._entry);

        this._sendButton = new Gtk.Button({
            icon_name: 'go-next-symbolic',
            tooltip_text: 'Send',
        });
        this._sendButton.add_css_class('suggested-action');
        this._sendButton.connect('clicked', () => this._send());
        composer.append(this._sendButton);

        footer.append(composer);
        page.append(footer);

        this._stack.add_named(page, 'chat');
    }

    _buildHistoryPage() {
        const page = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});

        const header = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_top: 18,
            margin_start: 18,
            margin_end: 18,
        });
        const heading = new Gtk.Label({
            label: 'Chat history',
            xalign: 0,
            hexpand: true,
        });
        heading.add_css_class('ai-chat-history-heading');
        header.append(heading);

        this._clearAllButton = new Gtk.Button({
            label: 'Clear All',
            tooltip_text: 'Delete all saved chats',
            valign: Gtk.Align.CENTER,
        });
        this._clearAllButton.add_css_class('flat');
        this._clearAllButton.connect('clicked', () => this._confirmClearAll());
        header.append(this._clearAllButton);

        page.append(header);

        const scroller = new Gtk.ScrolledWindow({vexpand: true, hexpand: true});
        scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);

        this._historyBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 18,
            margin_bottom: 18,
            margin_start: 18,
            margin_end: 18,
        });
        scroller.set_child(this._historyBox);
        page.append(scroller);
        this._stack.add_named(page, 'history');
    }

    // --- Menu actions --------------------------------------------------------

    _installActions() {
        this._addSwitchAction('thinking', 'enable-thinking');
        this._addSwitchAction('show-reasoning', 'show-reasoning');

        const preferences = new Gio.SimpleAction({name: 'preferences'});
        preferences.connect('activate', () => {
            try {
                Gio.Subprocess.new(
                    ['gnome-extensions', 'prefs', UUID],
                    Gio.SubprocessFlags.NONE);
            } catch (e) {
                logError(e);
            }
        });
        this._window.add_action(preferences);
    }

    _addSwitchAction(actionName, settingKey) {
        const action = new Gio.SimpleAction({
            name: actionName,
            state: GLib.Variant.new_boolean(this._settings.get_boolean(settingKey)),
        });
        action.connect('activate', () => {
            const next = !action.get_state().get_boolean();
            action.set_state(GLib.Variant.new_boolean(next));
            this._settings.set_boolean(settingKey, next);
        });
        const id = this._settings.connect(`changed::${settingKey}`, () => {
            action.set_state(GLib.Variant.new_boolean(
                this._settings.get_boolean(settingKey)));
        });
        this._settingsIds.push(id);
        this._window.add_action(action);
    }

    // --- Conversation navigation --------------------------------------------

    newChat() {
        this._cancelRequest();
        this._resetChat();
        this._showChat();
    }

    _resetChat() {
        this._conversation = null;
        this._clearTranscript();
        this._showEmptyState();
        this._setTitle('New chat');
        this._setStatus('');
    }

    _deleteConversation(id) {
        const isCurrent = this._conversation?.id === id;
        // Cancel before removing: cancellation can save a partial answer.
        if (isCurrent)
            this._cancelRequest();
        this._store.remove(id);
        if (isCurrent)
            this._resetChat();
        this._buildHistory();
    }

    _confirmClearAll() {
        const count = this._store.list().length;
        if (count === 0)
            return;

        const plural = count === 1 ? '' : 's';
        const dialog = new Adw.AlertDialog({
            heading: 'Delete all chats?',
            body: `This deletes all ${count} saved conversation${plural}. This cannot be undone.`,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete All');
        dialog.set_response_appearance(
            'delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_dialog, response) => {
            if (response !== 'delete')
                return;
            // Cancel before clearing: cancellation can save a partial answer.
            this._cancelRequest();
            this._store.clear();
            this._resetChat();
            this._buildHistory();
        });
        dialog.present(this._window);
    }

    showConversation(id) {
        this._cancelRequest();
        const conversation = id ? this._store.get(id) : null;
        if (!conversation) {
            this.newChat();
            if (id)
                this._setStatus('That chat is no longer saved.');
            return;
        }

        this._conversation = conversation;
        this._renderConversation();
        this._setStatus('');
        this._showChat();
    }

    showHistory() {
        this._cancelRequest();
        this._buildHistory();
        this._stack.set_visible_child_name('history');
        this._backButton.set_visible(true);
    }

    _showChat() {
        this._stack.set_visible_child_name('chat');
        this._backButton.set_visible(false);
        if (!this._conversation && !this._messagesBox.get_first_child()) {
            this._showEmptyState();
            this._setTitle('New chat');
        }
        this._entry.grab_focus();
    }

    _renderConversation() {
        this._clearTranscript();

        const messages = this._conversation?.messages ?? [];
        if (messages.length === 0) {
            this._showEmptyState();
            this._setTitle('New chat');
            return;
        }

        for (const message of messages) {
            if (message.role === 'user')
                this._addUserMessage(message.content, message.ts);
            else
                this._addStaticAssistantMessage(message.content, message.metrics ?? null);
        }

        const firstUser = messages.find(message => message.role === 'user');
        this._setTitle(this._conversation.title ||
            titleFor(firstUser?.content ?? ''));
    }

    _buildHistory() {
        let child;
        while ((child = this._historyBox.get_first_child()))
            this._historyBox.remove(child);

        const conversations = this._store.list();
        this._clearAllButton.set_sensitive(conversations.length > 0);
        if (conversations.length === 0) {
            const empty = new Gtk.Label({
                label: 'No saved chats yet. Ask something in the overview first.',
                xalign: 0,
                wrap: true,
                margin_top: 24,
            });
            empty.add_css_class('dim-label');
            this._historyBox.append(empty);
            return;
        }

        const list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            activate_on_single_click: true,
        });
        list.add_css_class('boxed-list');
        list.connect('row-activated', (_list, row) => {
            if (row._conversationId && this._store.get(row._conversationId))
                this.showConversation(row._conversationId);
        });

        for (const conversation of conversations) {
            const row = new Gtk.ListBoxRow({activatable: true});
            row._conversationId = conversation.id;

            const content = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
                margin_top: 10,
                margin_bottom: 10,
                margin_start: 12,
                margin_end: 12,
            });

            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 2,
                hexpand: true,
            });

            const title = new Gtk.Label({
                label: conversation.title,
                xalign: 0,
                wrap: false,
                hexpand: true,
                max_width_chars: 80,
                ellipsize: Pango.EllipsizeMode.END,
            });
            title.add_css_class('ai-chat-history-title');
            box.append(title);

            const meta = new Gtk.Label({
                label: `${formatDate(conversation.updated)}  ·  ${previewOf(conversation)}`,
                xalign: 0,
                hexpand: true,
                max_width_chars: 80,
                ellipsize: Pango.EllipsizeMode.END,
            });
            meta.add_css_class('dim-label');
            box.append(meta);

            content.append(box);

            // GtkListBox handles row clicks with a BUBBLE-phase gesture, so a
            // button that claims the press prevents row activation entirely.
            const deleteButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: 'Delete this chat',
                valign: Gtk.Align.CENTER,
            });
            deleteButton.add_css_class('flat');
            deleteButton.connect('clicked', () =>
                this._deleteConversation(conversation.id));
            content.append(deleteButton);

            row.set_child(content);
            list.append(row);
        }

        this._historyBox.append(list);
    }

    // --- Transcript ----------------------------------------------------------

    _clearTranscript() {
        this._emptyState = null;
        let child;
        while ((child = this._messagesBox.get_first_child()))
            this._messagesBox.remove(child);
    }

    _showEmptyState() {
        if (this._emptyState)
            return;
        const label = new Gtk.Label({
            label: 'Ask anything. Follow-up questions stay in this chat.',
            xalign: 0,
            wrap: true,
            margin_top: 24,
        });
        label.add_css_class('dim-label');
        this._messagesBox.append(label);
        this._emptyState = label;
    }

    _removeEmptyState() {
        if (!this._emptyState)
            return;
        this._messagesBox.remove(this._emptyState);
        this._emptyState = null;
    }

    _addUserMessage(text, ts) {
        this._removeEmptyState();

        const wrapper = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
        });
        wrapper.set_halign(Gtk.Align.END);
        wrapper.set_margin_top(4);

        if (ts) {
            const stamp = new Gtk.Label({
                label: formatDate(ts),
                xalign: 1,
            });
            stamp.add_css_class('ai-chat-timestamp');
            stamp.add_css_class('dim-label');
            wrapper.append(stamp);
        }

        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            hexpand: true,
        });
        row.set_halign(Gtk.Align.END);

        const label = new Gtk.Label({
            label: text,
            wrap: true,
            selectable: true,
            xalign: 0,
            max_width_chars: 70,
        });
        label.add_css_class('ai-chat-user');
        row.append(label);
        wrapper.append(row);
        this._messagesBox.append(wrapper);
        this._scrollToBottom();
    }

    _beginAssistantMessage() {
        this._removeEmptyState();

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            hexpand: true,
        });

        const reasoning = new Gtk.Label({
            label: '',
            wrap: true,
            selectable: true,
            xalign: 0,
            visible: false,
        });
        reasoning.add_css_class('ai-chat-reasoning');
        reasoning.set_opacity(0.7);
        box.append(reasoning);

        const toolsBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            visible: false,
        });
        box.append(toolsBox);

        const contentBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            hexpand: true,
        });
        contentBox.add_css_class('ai-chat-assistant');
        box.append(contentBox);

        const metricsLabel = new Gtk.Label({
            label: '',
            xalign: 0,
            wrap: true,
            selectable: true,
            visible: false,
        });
        metricsLabel.add_css_class('ai-chat-metrics');
        metricsLabel.add_css_class('dim-label');
        box.append(metricsLabel);

        this._messagesBox.append(box);
        this._current = {
            box,
            reasoning,
            toolsBox,
            contentBox,
            metricsLabel,
            metrics: null,
            blocks: [],
            lastAnswer: '',
            answer: '',
            reasoningText: '',
            reasoningActive: false,
            showReasoning: this._settings.get_boolean('show-reasoning'),
            failed: false,
        };
        this._scrollToBottom();
    }

    _addToolResultCard(name, text) {
        if (!this._current)
            return;

        const toolsBox = this._current.toolsBox;
        toolsBox.set_visible(true);

        const expander = new Gtk.Expander({
            label: toolLabel(name),
            expanded: text.length <= 1500,
        });
        expander.add_css_class('ai-chat-tool');

        const body = new Gtk.Label({
            label: text,
            wrap: true,
            selectable: true,
            xalign: 0,
            margin_top: 6,
        });
        if (text.startsWith('Error:') || text.startsWith('MCP error:'))
            body.add_css_class('error');
        expander.set_child(body);
        toolsBox.append(expander);
        this._scrollToBottom();
    }

    _addStaticAssistantMessage(text, metrics = null) {
        this._beginAssistantMessage();
        this._current.answer = text;
        this._current.metrics = metrics ?? null;
        this._renderCurrent();
        this._finishAssistantMessage();
    }

    _finishAssistantMessage() {
        const current = this._current;
        if (!current)
            return null;
        this._current = null;
        this._renderCurrent(current);

        if (current.answer.trim()) {
            const copy = new Gtk.Button({
                icon_name: 'edit-copy-symbolic',
                tooltip_text: 'Copy answer',
                halign: Gtk.Align.START,
            });
            copy.add_css_class('flat');
            copy.add_css_class('circular');
            copy.connect('clicked', () => this._copy(current.answer));
            current.box.append(copy);
        }

        return {answer: current.answer, metrics: current.metrics ?? null};
    }

    _failAssistantMessage(message) {
        const current = this._current;
        if (!current)
            return;
        current.failed = true;
        current.reasoning.set_visible(false);
        current.metricsLabel.set_visible(false);

        for (const entry of current.blocks)
            current.contentBox.remove(entry.widget);
        current.blocks = [];
        current.lastAnswer = message;

        const label = this._makeMarkdownLabel(escapeMarkup(message));
        label.add_css_class('error');
        current.contentBox.append(label);
        this._current = null;
    }

    _appendContent(text) {
        if (!this._current)
            this._beginAssistantMessage();
        if (this._current.answer.length >= MAX_ANSWER_CHARS)
            return;
        const remaining = MAX_ANSWER_CHARS - this._current.answer.length;
        this._current.answer += text.length > remaining ? text.slice(0, remaining) : text;
        this._current.reasoningActive = false;
        this._scheduleRender();
    }

    _appendNotice(text) {
        if (!this._current)
            this._beginAssistantMessage();
        if (this._current.answer.length >= MAX_ANSWER_CHARS)
            return;
        this._current.answer += `${this._current.answer ? '\n\n' : ''}${text}`;
        this._current.reasoningActive = false;
        this._scheduleRender();
    }

    _appendReasoning(text) {
        const current = this._current;
        if (!current || !current.showReasoning)
            return;
        if (current.reasoningText.length >= MAX_REASONING_CHARS)
            return;

        if (!current.reasoningActive && current.reasoningText.trim())
            current.reasoningText += '\n\n';
        current.reasoningActive = true;
        const remaining = MAX_REASONING_CHARS - current.reasoningText.length;
        current.reasoningText += text.length > remaining ? text.slice(0, remaining) : text;
        current.reasoning.set_visible(true);
        this._scheduleRender();
    }

    _scheduleRender() {
        if (this._renderId)
            return;
        this._renderId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, FLUSH_INTERVAL_MS, () => {
                this._renderId = 0;
                this._renderCurrent();
                return GLib.SOURCE_REMOVE;
            });
    }

    _renderCurrent(current = this._current) {
        if (!current)
            return;

        const stick = this._isAtBottom();
        if (current.reasoning.get_text() !== current.reasoningText)
            current.reasoning.set_text(current.reasoningText);

        if (current.metricsLabel) {
            const metricsText = current.metrics
                ? formatMetrics(current.metrics)
                : '';
            if (current.metricsLabel.get_text() !== metricsText)
                current.metricsLabel.set_text(metricsText);
            current.metricsLabel.set_visible(Boolean(metricsText));
        }

        if (current.lastAnswer !== current.answer) {
            current.lastAnswer = current.answer;
            this._renderMarkdown(current);
        }

        if (stick)
            this._scrollToBottom();
    }

    // --- Markdown rendering --------------------------------------------------

    _makeMarkdownLabel(markup, {xalign = 0} = {}) {
        const label = new Gtk.Label({
            wrap: true,
            selectable: true,
            xalign,
            hexpand: true,
        });
        label.set_markup(markup);
        label.connect('activate-link', (_label, uri) => {
            try {
                Gio.AppInfo.launch_default_for_uri(uri, null);
            } catch (e) {
                logError(e);
            }
            return true;
        });
        return label;
    }

    _childAt(box, index) {
        let child = box.get_first_child();
        for (let i = 0; i < index && child; i++)
            child = child.get_next_sibling();
        return child;
    }

    _createMarkdownBlock(block) {
        switch (block.type) {
        case 'heading': {
            const size = block.level === 1 ? 'x-large'
                : block.level === 2 ? 'large' : 'medium';
            return this._makeMarkdownLabel(
                `<span weight="bold" size="${size}">` +
                `${inlineToPango(block.text)}</span>`);
        }
        case 'paragraph':
            return this._makeMarkdownLabel(
                inlineToPango(block.text.replace(/\n/g, ' ')));
        case 'code': {
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 4,
            });
            box.add_css_class('ai-chat-code');

            if (block.lang) {
                const lang = new Gtk.Label({
                    label: block.lang,
                    xalign: 0,
                    hexpand: true,
                });
                lang.add_css_class('ai-chat-code-lang');
                lang.add_css_class('dim-label');
                box.append(lang);
            }

            const code = new Gtk.Label({
                label: block.text,
                wrap: true,
                selectable: true,
                xalign: 0,
                hexpand: true,
            });
            code.add_css_class('ai-chat-code-text');
            box.append(code);
            return box;
        }
        case 'list': {
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 4,
            });
            block.items.forEach((item, index) => {
                const row = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 8,
                });
                const marker = new Gtk.Label({
                    label: block.ordered ? `${block.start + index}.` : '•',
                    xalign: 0,
                    valign: Gtk.Align.START,
                });
                marker.add_css_class('ai-chat-list-marker');
                row.append(marker);
                row.append(this._makeMarkdownLabel(
                    inlineToPango(item.text.replace(/\n/g, ' '))));
                box.append(row);
            });
            return box;
        }
        case 'quote': {
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 4,
            });
            box.add_css_class('ai-chat-quote');
            for (const line of block.text.split('\n')) {
                if (line.trim()) {
                    box.append(this._makeMarkdownLabel(
                        `<i>${inlineToPango(line)}</i>`));
                }
            }
            return box;
        }
        case 'table':
            return this._createMarkdownTable(block);
        case 'rule':
            return new Gtk.Separator({orientation: Gtk.Orientation.HORIZONTAL});
        default:
            return new Gtk.Label({label: ''});
        }
    }

    _createMarkdownTable(block) {
        const grid = new Gtk.Grid({
            column_spacing: 18,
            row_spacing: 6,
            hexpand: true,
        });
        grid.add_css_class('ai-chat-table');

        const columns = Math.max(
            1,
            block.header.length,
            ...block.rows.map(row => row.length));

        const addCell = (value, column, row, header) => {
            const align = block.aligns[column] ?? 'left';
            const label = this._makeMarkdownLabel(
                inlineToPango(value ?? ''), {
                    xalign: align === 'right' ? 1
                        : align === 'center' ? 0.5 : 0,
                });
            if (header)
                label.add_css_class('ai-chat-table-header');
            grid.attach(label, column, row, 1, 1);
        };

        for (let column = 0; column < columns; column++)
            addCell(block.header[column], column, 0, true);
        block.rows.forEach((row, index) => {
            for (let column = 0; column < columns; column++)
                addCell(row[column], column, index + 1, false);
        });

        return grid;
    }

    _renderMarkdown(current) {
        const blocks = parseMarkdown(current.answer);
        const signatures = blocks.map(block => JSON.stringify(block));

        for (let i = current.blocks.length - 1; i >= blocks.length; i--) {
            current.contentBox.remove(current.blocks[i].widget);
            current.blocks.pop();
        }

        for (let i = 0; i < blocks.length; i++) {
            if (current.blocks[i] &&
                current.blocks[i].signature === signatures[i])
                continue;

            const widget = this._createMarkdownBlock(blocks[i]);
            const existing = current.blocks[i];

            if (!existing) {
                current.contentBox.append(widget);
                current.blocks.push({signature: signatures[i], widget});
                continue;
            }

            current.contentBox.remove(existing.widget);
            const before = this._childAt(current.contentBox, i);
            if (before)
                current.contentBox.insert_child_after(
                    widget, before.get_prev_sibling());
            else
                current.contentBox.append(widget);
            current.blocks[i] = {signature: signatures[i], widget};
        }
    }

    _isAtBottom() {
        const adjustment = this._chatScroller.vadjustment;
        if (!adjustment)
            return true;
        return adjustment.value + adjustment.page_size >= adjustment.upper - 64;
    }

    _scrollToBottom() {
        if (this._scrollId)
            return;
        this._scrollId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scrollId = 0;
            const adjustment = this._chatScroller.vadjustment;
            if (adjustment)
                adjustment.value = Math.max(0, adjustment.upper - adjustment.page_size);
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- Request lifecycle ---------------------------------------------------

    async _send() {
        if (this._busy)
            return;

        const text = this._entry.get_text().trim();
        if (!text)
            return;

        this._entry.set_text('');
        this._setStatus('');

        if (!this._conversation)
            this._conversation = this._store.create(text);

        const ts = Date.now();
        this._conversation.messages.push({role: 'user', content: text, ts});
        if (this._conversation.messages.length === 1) {
            this._conversation.title = titleFor(text);
            this._setTitle(this._conversation.title);
        }
        this._store.upsert(this._conversation);

        this._addUserMessage(text, ts);
        await this._respond();
    }

    // Answer the pending user message of the current conversation. The message
    // is already in the transcript, either just typed or restored from a saved
    // chat whose reply never started (for example when the overview result was
    // activated before the search provider's debounce fired).
    async _respond() {
        const conversation = this._conversation;
        if (this._busy || !conversation)
            return;
        if (conversation.messages.at(-1)?.role !== 'user')
            return;

        this._beginAssistantMessage();
        this._setBusy(true);
        this._setStatus('Thinking…');

        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        try {
            const baseUrl = normalizeEndpoint(this._settings.get_string('endpoint'));
            const apiKey = this._settings.get_string('api-key').trim();
            const configured = this._settings.get_string('model').trim();
            const model = configured || await this._client.discoverModel({
                baseUrl,
                apiKey,
                cancellable,
            });
            if (cancellable.is_cancelled())
                return;

            const toolsEnabled = this._settings.get_boolean('enable-tools');
            let registry = {
                definitions: [],
                execute: undefined,
                warnings: [],
            };

            if (toolsEnabled) {
                if (this._settings.get_boolean('enable-mcp'))
                    this._setStatus('Loading tools…');
                registry = await buildToolRegistry(this._settings, {
                    cancellable,
                    onStatus: text => {
                        if (this._cancellable === cancellable)
                            this._setStatus(text);
                    },
                });
                if (cancellable.is_cancelled())
                    return;
                if (registry.warnings.length)
                    log(`AI Search MCP: ${registry.warnings.join('; ')}`);
                this._setStatus('Thinking…');
            }

            this._startModelWatch(baseUrl, apiKey, model, cancellable);

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
                enableThinking: this._settings.get_boolean('enable-thinking'),
                maxToolRounds: this._settings.get_int('max-tool-rounds'),
                cancellable,
            })) {
                if (cancellable.is_cancelled())
                    return;

                switch (event.type) {
                case 'content':
                    this._appendContent(event.text);
                    this._stopModelWatch();
                    this._setStatus('Responding…');
                    break;
                case 'reasoning':
                    this._appendReasoning(event.text);
                    this._setStatus('Thinking…');
                    break;
                case 'status':
                    if (this._current)
                        this._current.reasoningActive = false;
                    this._setStatus(event.text);
                    break;
                case 'tool-result':
                    this._addToolResultCard(event.name, event.text);
                    break;
                case 'notice':
                    this._appendNotice(event.text);
                    break;
                case 'metrics':
                    if (this._current)
                        this._current.metrics = event.metrics;
                    this._scheduleRender();
                    break;
                }
            }

            if (cancellable.is_cancelled())
                return;

            const result = this._finishAssistantMessage();
            if (result?.answer?.trim()) {
                this._conversation.messages.push({
                    role: 'assistant',
                    content: result.answer,
                    metrics: result.metrics,
                });
                this._store.upsert(this._conversation);
            }
            this._setStatus('');
        } catch (e) {
            if (cancellable.is_cancelled() || isCancellationError(e))
                return;
            const message = e.message ?? String(e);
            this._failAssistantMessage(message);
            this._setStatus(`Error: ${message}`, true);
        } finally {
            if (this._cancellable === cancellable) {
                this._cancellable = null;
                this._stopModelWatch();
                this._setBusy(false);
            }
        }
    }

    _cancelRequest() {
        const cancellable = this._cancellable;
        this._cancellable = null;
        if (cancellable)
            cancellable.cancel();
        this._stopModelWatch();

        if (this._current && !this._current.failed &&
            this._current.answer.trim() && this._conversation) {
            this._conversation.messages.push({
                role: 'assistant',
                content: this._current.answer,
                metrics: this._current.metrics ?? null,
            });
            this._store.upsert(this._conversation);
        } else if (this._current && !this._current.failed &&
            !this._current.answer.trim()) {
            this._current.box.get_parent()?.remove(this._current.box);
        }

        this._current = null;
        this._setBusy(false);
    }

    _startModelWatch(baseUrl, apiKey, model, cancellable) {
        this._stopModelWatch();
        if (!model)
            return;

        this._modelWatch = new ModelWatch({
            client: this._client,
            baseUrl,
            apiKey,
            model,
            cancellable,
            onUpdate: state => {
                if (!this._busy || this._cancellable !== cancellable)
                    return;
                if (state.loading) {
                    const text = formatModelState(state);
                    if (text)
                        this._setStatus(text);
                } else if (this._statusLabel.get_text().startsWith('Loading model')) {
                    this._setStatus('Thinking…');
                }
            },
        });
        this._modelWatch.start();
    }

    _stopModelWatch() {
        if (this._modelWatch) {
            this._modelWatch.stop();
            this._modelWatch = null;
        }
    }

    _setBusy(busy) {
        this._busy = busy;
        this._spinner.set_spinning(busy);
        this._spinner.set_visible(busy);
        this._sendButton.set_sensitive(!busy);
        if (!busy && this._stack.visible_child_name === 'chat')
            this._entry.grab_focus();
    }

    _setStatus(text, isError = false) {
        const value = text ?? '';
        if (this._statusLabel.get_text() !== value)
            this._statusLabel.set_text(value);
        this._statusLabel.set_visible(Boolean(value));
        if (isError)
            this._statusLabel.add_css_class('error');
        else
            this._statusLabel.remove_css_class('error');
    }

    _setTitle(subtitle) {
        this._title.set_title('AI Chat');
        const compact = String(subtitle ?? '').replace(/\s+/g, ' ').trim();
        this._title.set_subtitle(
            compact.length > 48 ? `${compact.slice(0, 47)}…` : compact);
    }

    _copy(text) {
        const value = String(text ?? '').trim();
        if (!value)
            return;
        Gdk.Display.get_default()?.get_clipboard().set(value);
        this._setStatus('Copied to clipboard');
        if (this._copyId)
            GLib.source_remove(this._copyId);
        this._copyId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._copyId = 0;
            if (!this._busy)
                this._setStatus('');
            return GLib.SOURCE_REMOVE;
        });
    }

    _shutdown() {
        this._cancelRequest();
        if (this._renderId) {
            GLib.source_remove(this._renderId);
            this._renderId = 0;
        }
        if (this._scrollId) {
            GLib.source_remove(this._scrollId);
            this._scrollId = 0;
        }
        if (this._copyId) {
            GLib.source_remove(this._copyId);
            this._copyId = 0;
        }
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._client.destroy();
        this._store.destroy();
    }
}

function main() {
    const settings = loadSettings();
    const store = new ChatStore();
    let window = null;

    const app = new Adw.Application({
        application_id: APP_ID,
        flags: Gio.ApplicationFlags.HANDLES_COMMAND_LINE,
    });

    app.connect('command-line', (application, commandLine) => {
        if (!window)
            window = new ChatWindow(application, settings, store);
        window.open(parseArgs(commandLine.get_arguments().slice(1)));
        window.window.present();
        commandLine.set_exit_status(0);
        return 0;
    });

    app.run([GLib.get_prgname(), ...ARGV]);
}

main();

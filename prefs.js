// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {OpenAIClient, normalizeEndpoint} from './lib/openaiClient.js';
import {launchChatWindow} from './lib/launch.js';
import {parseMcpServers, listMcpTools} from './lib/mcp.js';
import {addResettableEntry} from './lib/prefsRows.js';

const CHECK_DEBOUNCE_MS = 600;
const CHECK_TIMEOUT_SECONDS = 8;

let statusCssInstalled = false;

function installStatusCss() {
    if (statusCssInstalled)
        return;
    statusCssInstalled = true;

    const display = Gdk.Display.get_default();
    if (!display)
        return;

    const provider = new Gtk.CssProvider();
    provider.load_from_string(`
        .ai-connect-ok {
            color: #2ec27e;
        }
        .ai-connect-error {
            color: #e01b24;
        }
    `);
    Gtk.StyleContext.add_provider_for_display(
        display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

/* Adw.ComboRow sizes its popup to the row, so every model id is ellipsized to
 * the same short stub. This row keeps a plain popover instead, letting the list
 * take the width of its widest entry and wrap the longest ids. */
const MODEL_LABEL_MAX_CHARS = 56;

class ModelSelector {
    constructor({title, subtitle}) {
        this._labels = ['Auto (first loaded model)'];
        this._checks = [];
        this._selected = 0;
        this._updating = false;
        this.onSelected = null;

        this.row = new Adw.ActionRow({title, subtitle});

        this._valueLabel = new Gtk.Label({
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: MODEL_LABEL_MAX_CHARS,
        });
        const valueBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
        });
        valueBox.append(this._valueLabel);
        valueBox.append(new Gtk.Image({icon_name: 'pan-down-symbolic'}));

        this._button = new Gtk.MenuButton({
            child: valueBox,
            valign: Gtk.Align.CENTER,
        });
        this._button.add_css_class('flat');

        this._list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            activate_on_single_click: true,
        });

        this._scroller = new Gtk.ScrolledWindow({
            propagate_natural_width: true,
            propagate_natural_height: true,
            max_content_height: 480,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        this._scroller.set_child(this._list);

        this._popover = new Gtk.Popover({child: this._scroller});
        this._button.popover = this._popover;

        this.row.add_suffix(this._button);
        this.row.activatable_widget = this._button;

        this._list.connect('row-selected', (list, row) => {
            if (!row || this._updating)
                return;
            this._selected = row.get_index();
            this._updateLabel();
            this._updateChecks();
            this.onSelected?.(this._selected);
        });
    }

    setItems(labels) {
        this._labels = labels;

        this._updating = true;
        this._list.remove_all();
        this._checks = [];
        for (const text of labels) {
            const label = new Gtk.Label({
                label: text,
                xalign: 0,
                hexpand: true,
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                max_width_chars: MODEL_LABEL_MAX_CHARS,
            });
            const check = new Gtk.Image({
                icon_name: 'object-select-symbolic',
                visible: false,
            });
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
                margin_start: 12,
                margin_end: 12,
                margin_top: 8,
                margin_bottom: 8,
            });
            box.append(label);
            box.append(check);

            const row = new Gtk.ListBoxRow({child: box, tooltip_text: text});
            this._list.append(row);
            this._checks.push(check);
        }
        this._updating = false;

        this.setSelected(Math.min(this._selected, labels.length - 1));
    }

    setSelected(index) {
        if (index < 0 || index >= this._labels.length)
            index = 0;

        this._updating = true;
        this._selected = index;
        this._list.select_row(this._list.get_row_at_index(index));
        this._updating = false;

        this._updateLabel();
        this._updateChecks();
    }

    _updateLabel() {
        const text = this._labels[this._selected] ?? '';
        this._valueLabel.label = text;
        this._valueLabel.tooltip_text = text;
    }

    _updateChecks() {
        this._checks.forEach((check, index) => {
            check.visible = index === this._selected;
        });
    }
}

class ServerPanel {
    constructor(settings, {endpointRow, apiKeyRow, modelSelector, refreshButton}) {
        installStatusCss();

        this._settings = settings;
        this._endpointRow = endpointRow;
        this._apiKeyRow = apiKeyRow;
        this._modelSelector = modelSelector;
        this._refreshButton = refreshButton;
        this._client = new OpenAIClient();

        this._models = [];
        this._modelIds = [''];
        this._serial = 0;
        this._debounceId = 0;
        this._timeoutId = 0;
        this._cancellable = null;
        this._destroyed = false;

        this._spinner = new Gtk.Spinner({
            visible: false,
            spinning: false,
            width_request: 16,
            height_request: 16,
            valign: Gtk.Align.CENTER,
        });
        this._statusIcon = new Gtk.Image({
            icon_name: 'emblem-ok-symbolic',
            pixel_size: 16,
            visible: false,
            valign: Gtk.Align.CENTER,
        });
        this._statusBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            valign: Gtk.Align.CENTER,
        });
        this._statusBox.append(this._spinner);
        this._statusBox.append(this._statusIcon);
        endpointRow.add_suffix(this._statusBox);

        this._endpointChangedId = endpointRow.connect('notify::text', () => {
            this._cancelInFlight();
            this._scheduleCheck();
        });
        this._apiKeyChangedId = apiKeyRow.connect('notify::text', () => {
            this._cancelInFlight();
            this._scheduleCheck();
        });
        this._refreshId = refreshButton.connect('clicked', () => {
            this._checkNow();
        });
        modelSelector.onSelected = index => {
            this._onModelSelected(index);
        };

        this._populateModels([]);
        this._scheduleCheck(80);
    }

    _scheduleCheck(delay = CHECK_DEBOUNCE_MS) {
        if (this._destroyed)
            return;

        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }

        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._debounceId = 0;
            this._checkNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelInFlight() {
        // Invalidate any response that is already on the wire.
        this._serial += 1;

        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
    }

    _checkNow() {
        if (this._destroyed)
            return;

        this._cancelInFlight();

        const endpoint = this._endpointRow.text.trim();
        if (!endpoint) {
            this._setIdle();
            return;
        }

        const serial = ++this._serial;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        let timedOut = false;

        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, CHECK_TIMEOUT_SECONDS, () => {
                timedOut = true;
                this._timeoutId = 0;
                cancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });

        this._setChecking();
        this._runCheck(serial, endpoint, cancellable, () => timedOut).catch(logError);
    }

    async _runCheck(serial, endpoint, cancellable, timedOut) {
        try {
            const apiKey = this._apiKeyRow.text.trim();
            const baseUrl = normalizeEndpoint(endpoint);
            const models = await this._client.listModels({baseUrl, apiKey, cancellable});

            if (this._destroyed || serial !== this._serial)
                return;

            this._onModels(models);
        } catch (e) {
            if (this._destroyed || serial !== this._serial)
                return;

            const message = timedOut()
                ? `Timed out after ${CHECK_TIMEOUT_SECONDS} seconds.`
                : (e.message ?? String(e));
            this._setError(message);
        } finally {
            if (serial === this._serial && this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
            if (this._cancellable === cancellable)
                this._cancellable = null;
        }
    }

    _onModels(models) {
        this._models = models;

        const loaded = models.filter(model => model.loaded).length;
        let message;
        if (models.length === 0)
            message = 'Connected, but the server advertised no models.';
        else if (loaded > 0)
            message = `Connected — ${loaded} loaded, ${models.length} available.`;
        else
            message = `Connected — ${models.length} model(s) available.`;

        this._setOk(message);
        this._populateModels(models);
    }

    _populateModels(models) {
        const current = (this._settings.get_string('model') ?? '').trim();
        const ids = [''];
        const labels = ['Auto (first loaded model)'];

        for (const model of models) {
            ids.push(model.id);
            labels.push(model.loaded ? `${model.id} — loaded` : model.id);
        }

        if (current && !ids.includes(current)) {
            ids.push(current);
            labels.push(`${current} — not advertised`);
        }

        this._modelIds = ids;
        this._modelSelector.setItems(labels);
        this._modelSelector.setSelected(Math.max(0, ids.indexOf(current)));
    }

    _onModelSelected(index) {
        if (this._destroyed)
            return;

        const model = this._modelIds[index];
        if (model === undefined)
            return;

        if (this._settings.get_string('model') !== model)
            this._settings.set_string('model', model);
    }

    _setChecking() {
        this._spinner.spinning = true;
        this._spinner.visible = true;
        this._statusIcon.visible = false;
        this._statusBox.tooltip_text = 'Checking server…';
    }

    _setOk(message) {
        this._spinner.spinning = false;
        this._spinner.visible = false;
        this._statusIcon.icon_name = 'emblem-ok-symbolic';
        this._statusIcon.remove_css_class('ai-connect-error');
        this._statusIcon.add_css_class('ai-connect-ok');
        this._statusIcon.visible = true;
        this._statusBox.tooltip_text = message;
    }

    _setError(message) {
        this._spinner.spinning = false;
        this._spinner.visible = false;
        this._statusIcon.icon_name = 'window-close-symbolic';
        this._statusIcon.remove_css_class('ai-connect-ok');
        this._statusIcon.add_css_class('ai-connect-error');
        this._statusIcon.visible = true;
        this._statusBox.tooltip_text = `Server error: ${message}`;
    }

    _setIdle() {
        this._spinner.spinning = false;
        this._spinner.visible = false;
        this._statusIcon.visible = false;
        this._statusBox.tooltip_text = '';
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._serial += 1;
        this._cancelInFlight();

        try {
            this._endpointRow.disconnect(this._endpointChangedId);
            this._apiKeyRow.disconnect(this._apiKeyChangedId);
            this._refreshButton.disconnect(this._refreshId);
        } catch {
            // Rows may already be disposed
        }
        this._modelSelector.onSelected = null;

        this._client.destroy();
        this._client = null;
    }
}

function addEntry(group, settings, key, title) {
    const row = new Adw.EntryRow({title});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function addSpin(group, settings, key, title, subtitle, lower, upper, step) {
    const adjustment = new Gtk.Adjustment({
        lower,
        upper,
        step_increment: step,
        page_increment: step * 5,
        value: settings.get_int(key),
    });
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment,
        digits: 0,
        numeric: true,
        snap_to_ticks: true,
    });

    const changedId = row.connect('notify::value', () => {
        const value = Math.round(row.value);
        if (settings.get_int(key) !== value)
            settings.set_int(key, value);
    });

    group.add(row);
    return {row, changedId};
}

export default class AiSearchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const cleanup = [];

        window.title = 'AI Search';
        window.set_default_size(680, 780);
        window.search_enabled = true;

        const page = new Adw.PreferencesPage();
        window.add(page);

        // --- Server ---------------------------------------------------------
        const serverGroup = new Adw.PreferencesGroup({
            title: 'Model server',
            description: 'Any OpenAI-compatible server works. Unsloth Studio ' +
                'defaults to http://127.0.0.1:8888/v1.',
        });
        page.add(serverGroup);

        const endpointRow = addEntry(serverGroup, settings, 'endpoint', 'Endpoint URL');

        const apiKeyRow = new Adw.PasswordEntryRow({
            title: 'API key (optional)',
        });
        settings.bind('api-key', apiKeyRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        serverGroup.add(apiKeyRow);

        const modelSelector = new ModelSelector({
            title: 'Model',
            subtitle: 'Populated from /v1/models. Refresh after downloading models.',
        });
        serverGroup.add(modelSelector.row);

        const refreshButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Refresh model list',
            valign: Gtk.Align.CENTER,
        });
        refreshButton.add_css_class('flat');
        modelSelector.row.add_suffix(refreshButton);

        const serverPanel = new ServerPanel(settings, {
            endpointRow,
            apiKeyRow,
            modelSelector,
            refreshButton,
        });
        this._serverPanel = serverPanel;
        cleanup.push(() => serverPanel.destroy());

        // --- Behaviour ------------------------------------------------------
        const behaviourGroup = new Adw.PreferencesGroup({
            title: 'Behaviour',
            description: 'The search provider waits for you to stop typing before ' +
                'sending a request.',
        });
        page.add(behaviourGroup);

        const debounce = addSpin(behaviourGroup, settings, 'debounce-ms',
            'Debounce', 'Milliseconds to wait after typing stops', 0, 3000, 50);
        cleanup.push(() => debounce.row.disconnect(debounce.changedId));

        const thinkingRow = new Adw.SwitchRow({
            title: 'Enable thinking / reasoning',
            subtitle: 'Let the model reason before answering. Turn off for faster ' +
                'answers on models that support disabling thinking.',
        });
        settings.bind('enable-thinking', thinkingRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(thinkingRow);

        const reasoningRow = new Adw.SwitchRow({
            title: 'Show reasoning / thinking',
            subtitle: 'Display the thinking stream above the answer. Requires ' +
                'thinking to be enabled and a model that streams reasoning.',
        });
        settings.bind('show-reasoning', reasoningRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(reasoningRow);

        const systemPromptRow = addResettableEntry(
            behaviourGroup, settings, 'system-prompt', 'System prompt');
        cleanup.push(systemPromptRow.destroy);

        // --- Chats ----------------------------------------------------------
        const chatsGroup = new Adw.PreferencesGroup({
            title: 'Chats',
            description: 'Click the AI result in the overview to open it in the ' +
                'chat window and keep asking follow-up questions.',
        });
        page.add(chatsGroup);

        const historyRow = new Adw.ActionRow({
            title: 'Chat history',
            subtitle: 'Reopen a previous conversation and continue it.',
        });
        const openHistoryButton = new Gtk.Button({
            label: 'Open',
            valign: Gtk.Align.CENTER,
        });
        openHistoryButton.add_css_class('flat');
        const openHistoryId = openHistoryButton.connect('clicked', () => {
            try {
                launchChatWindow(this.path, {history: true});
            } catch (e) {
                logError(e);
            }
        });
        historyRow.add_suffix(openHistoryButton);
        historyRow.activatable_widget = openHistoryButton;
        chatsGroup.add(historyRow);
        cleanup.push(() => openHistoryButton.disconnect(openHistoryId));

        // --- Tools ----------------------------------------------------------
        const toolsGroup = new Adw.PreferencesGroup({
            title: 'Tools',
            description: 'Read-only tools return data inline: get_datetime, ' +
                'get_system_info, get_weather, get_country_info, ' +
                'search_wikipedia, and convert_currency.',
        });
        page.add(toolsGroup);

        const toolsRow = new Adw.SwitchRow({
            title: 'Enable tool calling',
            subtitle: 'Let the model call the tools above via function calling.',
        });
        settings.bind('enable-tools', toolsRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        toolsGroup.add(toolsRow);

        const webToolsRow = new Adw.SwitchRow({
            title: 'Enable web data tools',
            subtitle: 'Weather, country and population lookups, Wikipedia and ' +
                'web search, page reading, and currency conversion. Results ' +
                'come back inline; nothing opens a browser.',
        });
        settings.bind('enable-web-tools', webToolsRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        toolsGroup.add(webToolsRow);

        const rounds = addSpin(toolsGroup, settings, 'max-tool-rounds',
            'Maximum tool rounds', 'How many tool/answer loops to allow per query',
            0, 8, 1);
        cleanup.push(() => rounds.row.disconnect(rounds.changedId));

        // --- MCP ------------------------------------------------------------
        const mcpGroup = new Adw.PreferencesGroup({
            title: 'MCP servers',
            description: 'Expose tools from Model Context Protocol servers. ' +
                'Configuration is a JSON array:\n' +
                '[{"name": "DeepWiki", "url": "https://mcp.deepwiki.com/mcp", ' +
                '"headers": {}, "enabled": true}]\n' +
                'Headers can carry an Authorization token. Only http(s) servers are allowed.',
        });
        page.add(mcpGroup);

        const mcpRow = new Adw.SwitchRow({
            title: 'Enable MCP tools',
            subtitle: 'Discover the tools below and let the model call them.',
        });
        settings.bind('enable-mcp', mcpRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        mcpGroup.add(mcpRow);

        const mcpBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });

        const editorScroll = new Gtk.ScrolledWindow({
            min_content_height: 150,
            hexpand: true,
        });
        editorScroll.set_policy(
            Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);

        const editor = new Gtk.TextView({
            monospace: true,
            wrap_mode: Gtk.WrapMode.NONE,
            top_margin: 8,
            bottom_margin: 8,
            left_margin: 8,
            right_margin: 8,
        });
        editor.get_buffer().set_text(settings.get_string('mcp-servers'), -1);
        editorScroll.set_child(editor);

        const editorFrame = new Gtk.Frame();
        editorFrame.set_child(editorScroll);
        mcpBox.append(editorFrame);

        const mcpActions = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });
        const saveMcpButton = new Gtk.Button({label: 'Save'});
        saveMcpButton.add_css_class('suggested-action');
        const testMcpButton = new Gtk.Button({label: 'Save & test'});
        const mcpStatus = new Gtk.Label({
            xalign: 0,
            wrap: true,
            hexpand: true,
            visible: false,
        });
        mcpStatus.set_opacity(0.8);
        mcpActions.append(saveMcpButton);
        mcpActions.append(testMcpButton);
        mcpActions.append(mcpStatus);
        mcpBox.append(mcpActions);
        mcpGroup.add(mcpBox);

        let mcpDisposed = false;
        let mcpTestCancellable = null;

        const readEditor = () => {
            const buffer = editor.get_buffer();
            return buffer.get_text(
                buffer.get_start_iter(), buffer.get_end_iter(), false);
        };

        const setMcpStatus = (text, isError = false) => {
            if (mcpDisposed)
                return;
            mcpStatus.set_text(text);
            mcpStatus.set_visible(Boolean(text));
            if (isError)
                mcpStatus.add_css_class('error');
            else
                mcpStatus.remove_css_class('error');
        };

        const saveMcpConfig = () => {
            try {
                const servers = parseMcpServers(readEditor(), {strict: true});
                const pretty = JSON.stringify(servers, null, 2);
                settings.set_string('mcp-servers', pretty);
                if (readEditor() !== pretty)
                    editor.get_buffer().set_text(pretty, -1);
                setMcpStatus(`Saved ${servers.length} server(s).`);
                return servers;
            } catch (e) {
                setMcpStatus(e.message, true);
                return null;
            }
        };

        const saveMcpId = saveMcpButton.connect('clicked', () => {
            saveMcpConfig();
        });

        const testMcpId = testMcpButton.connect('clicked', async () => {
            const servers = saveMcpConfig();
            if (!servers || mcpDisposed)
                return;

            const enabled = servers.filter(server => server.enabled);
            if (enabled.length === 0) {
                setMcpStatus('No enabled servers to test.', true);
                return;
            }

            mcpTestCancellable?.cancel();
            const cancellable = new Gio.Cancellable();
            mcpTestCancellable = cancellable;
            saveMcpButton.set_sensitive(false);
            testMcpButton.set_sensitive(false);
            setMcpStatus('Testing…');

            try {
                const results = await Promise.allSettled(enabled.map(server =>
                    listMcpTools(server, {cancellable, force: true})));
                if (mcpDisposed)
                    return;

                const lines = results.map((result, index) => {
                    if (result.status === 'fulfilled')
                        return `${enabled[index].name}: ${result.value.length} tool(s)`;
                    return `${enabled[index].name}: ${result.reason?.message ?? 'failed'}`;
                });
                setMcpStatus(lines.join('\n'),
                    results.some(result => result.status === 'rejected'));
            } catch (e) {
                if (!cancellable.is_cancelled())
                    setMcpStatus(e.message, true);
            } finally {
                if (mcpTestCancellable === cancellable)
                    mcpTestCancellable = null;
                if (!mcpDisposed) {
                    saveMcpButton.set_sensitive(true);
                    testMcpButton.set_sensitive(true);
                }
            }
        });

        cleanup.push(() => {
            mcpDisposed = true;
            mcpTestCancellable?.cancel();
            mcpTestCancellable = null;
            saveMcpButton.disconnect(saveMcpId);
            testMcpButton.disconnect(testMcpId);
        });

        const noteGroup = new Adw.PreferencesGroup({
            title: 'Notes',
            description: 'The API key and MCP Authorization headers are stored ' +
                'in the GNOME settings database (dconf) as plain text, like most ' +
                'extension settings. For a local server an API key is usually not needed.',
        });
        page.add(noteGroup);

        window.connect('close-request', () => {
            for (const fn of cleanup)
                fn();
            cleanup.length = 0;
            return false;
        });
    }
}

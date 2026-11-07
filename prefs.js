import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {OpenAIClient, normalizeEndpoint} from './lib/openaiClient.js';
import {launchChatWindow} from './lib/launch.js';

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

class ServerPanel {
    constructor(settings, {endpointRow, apiKeyRow, modelRow, refreshButton}) {
        installStatusCss();

        this._settings = settings;
        this._endpointRow = endpointRow;
        this._apiKeyRow = apiKeyRow;
        this._modelRow = modelRow;
        this._refreshButton = refreshButton;
        this._client = new OpenAIClient();

        this._models = [];
        this._modelIds = [''];
        this._serial = 0;
        this._debounceId = 0;
        this._timeoutId = 0;
        this._cancellable = null;
        this._updatingCombo = false;
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
        this._selectionId = modelRow.connect('notify::selected', () => {
            this._onModelSelected();
        });

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
        this._updatingCombo = true;
        this._modelRow.model = Gtk.StringList.new(labels);
        this._modelRow.selected = Math.max(0, ids.indexOf(current));
        this._updatingCombo = false;
    }

    _onModelSelected() {
        if (this._updatingCombo || this._destroyed)
            return;

        const model = this._modelIds[this._modelRow.selected];
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
            this._modelRow.disconnect(this._selectionId);
        } catch {
            // Rows may already be disposed
        }

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

        const modelRow = new Adw.ComboRow({
            title: 'Model',
            subtitle: 'Populated from /v1/models. Refresh after downloading models.',
        });
        modelRow.model = Gtk.StringList.new(['Auto (first loaded model)']);
        serverGroup.add(modelRow);

        const refreshButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Refresh model list',
            valign: Gtk.Align.CENTER,
        });
        refreshButton.add_css_class('flat');
        modelRow.add_suffix(refreshButton);

        const serverPanel = new ServerPanel(settings, {
            endpointRow,
            apiKeyRow,
            modelRow,
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

        addEntry(behaviourGroup, settings, 'system-prompt', 'System prompt');

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
            description: 'Tools run locally in the extension or chat window: ' +
                'get_datetime, get_system_info, open_application, open_url.',
        });
        page.add(toolsGroup);

        const toolsRow = new Adw.SwitchRow({
            title: 'Enable tool calling',
            subtitle: 'Let the model call the local tools above via function calling.',
        });
        settings.bind('enable-tools', toolsRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        toolsGroup.add(toolsRow);

        const rounds = addSpin(toolsGroup, settings, 'max-tool-rounds',
            'Maximum tool rounds', 'How many tool/answer loops to allow per query',
            0, 8, 1);
        cleanup.push(() => rounds.row.disconnect(rounds.changedId));

        const noteGroup = new Adw.PreferencesGroup({
            title: 'Notes',
            description: 'The API key is stored in the GNOME settings database ' +
                '(dconf) as plain text, like most extension settings. ' +
                'For a local server it is usually not needed.',
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

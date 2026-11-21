// SPDX-License-Identifier: GPL-3.0-or-later
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

/**
 * A single full-width search result row that hands the typed query to the chat
 * window. The shell caches result actors per result id, so this object survives
 * multiple searches and is reset by the provider through update().
 */
export const AiResultRow = GObject.registerClass(
class AiResultRow extends St.Button {
    _init(provider) {
        super._init({
            style_class: 'ai-search-result list-search-result',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
            accessible_name: 'AI Search',
        });

        this._provider = provider;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            style_class: 'ai-search-content ai-search-header',
        });
        this.set_child(box);

        box.add_child(new St.Icon({
            icon_name: 'system-search-symbolic',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        box.add_child(new St.Label({
            text: 'AI Search',
            style_class: 'ai-search-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._statusLabel = new St.Label({
            text: '',
            style_class: 'ai-search-status',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 160,
        });
        box.add_child(this._statusLabel);
    }

    vfunc_clicked() {
        this.activate();
    }

    activate() {
        this._provider.openChat();
    }

    update({status = ''} = {}) {
        if (this._statusLabel.text !== status)
            this._statusLabel.text = status;
    }
});

/**
 * A compact second row that opens the saved-conversation list. Kept separate
 * from the search row so clicking the search row opens the chat window instead.
 */
export const AiHistoryRow = GObject.registerClass(
class AiHistoryRow extends St.Button {
    _init(provider, description) {
        super._init({
            style_class: 'ai-search-result ai-search-history list-search-result',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
            accessible_name: 'AI chat history',
        });

        this._provider = provider;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            style_class: 'ai-search-content ai-search-header',
        });
        this.set_child(box);

        box.add_child(new St.Icon({
            icon_name: 'document-open-recent-symbolic',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        box.add_child(new St.Label({
            text: 'AI chat history',
            style_class: 'ai-search-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        box.add_child(new St.Label({
            text: description ?? '',
            style_class: 'ai-search-status',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 160,
        }));
    }

    vfunc_clicked() {
        this.activate();
    }

    activate() {
        this._provider.openChatHistory();
    }
});

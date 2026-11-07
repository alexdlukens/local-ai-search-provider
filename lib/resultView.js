import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';

/**
 * A single full-width search result row that can be updated in place while the
 * model streams. The shell caches result actors per result id, so this object
 * survives multiple searches and is simply reset by the provider.
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
            accessible_name: 'AI answer',
        });

        this._provider = provider;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: false,
            style_class: 'ai-search-content',
        });
        this.set_child(box);

        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            style_class: 'ai-search-header',
        });
        box.add_child(header);

        const icon = new St.Icon({
            icon_name: 'system-search-symbolic',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(icon);

        this._title = new St.Label({
            text: 'AI Search',
            style_class: 'ai-search-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._title);

        this._statusLabel = new St.Label({
            text: '',
            style_class: 'ai-search-status',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._statusLabel.opacity = 160;
        header.add_child(this._statusLabel);

        this._spinner = new Spinner(16);
        this._spinner.y_align = Clutter.ActorAlign.CENTER;
        this._spinner.hide();
        header.add_child(this._spinner);

        this._reasoningLabel = new St.Label({
            text: '',
            style_class: 'ai-search-reasoning',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        this._reasoningLabel.opacity = 150;
        this._makeWrappable(this._reasoningLabel);
        this._reasoningLabel.hide();
        box.add_child(this._reasoningLabel);

        this._answerLabel = new St.Label({
            text: '',
            style_class: 'ai-search-answer',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        this._makeWrappable(this._answerLabel);
        this._answerLabel.hide();
        box.add_child(this._answerLabel);

        this._scrollId = 0;

        this.connect('destroy', () => {
            if (this._scrollId) {
                GLib.source_remove(this._scrollId);
                this._scrollId = 0;
            }
        });
    }

    _makeWrappable(label) {
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    }

    vfunc_clicked() {
        this.activate();
    }

    activate() {
        this._provider.openChat();
    }

    update({answer = '', reasoning = '', status = '', busy = false, error = '', showReasoning = false}) {
        const wasAtBottom = this._isAtBottom();
        const reasoningText = showReasoning ? reasoning : '';

        if (this._reasoningLabel.text !== reasoningText) {
            this._reasoningLabel.text = reasoningText;
            this._reasoningLabel.visible = Boolean(reasoningText);
        }

        const answerText = error ? error : answer;
        const answerChanged = this._answerLabel.text !== answerText;
        if (answerChanged) {
            this._answerLabel.text = answerText;
            this._answerLabel.visible = Boolean(answerText);
        }

        if (error) {
            this._answerLabel.add_style_class_name('ai-search-error');
        } else {
            this._answerLabel.remove_style_class_name('ai-search-error');
        }

        if (this._statusLabel.text !== status)
            this._statusLabel.text = status;

        if (busy) {
            if (!this._spinner.visible) {
                this._spinner.show();
                this._spinner.play();
            }
        } else if (this._spinner.visible) {
            this._spinner.stop();
            this._spinner.hide();
        }

        if (answerChanged || reasoningText)
            this._scrollToBottom(wasAtBottom);
    }

    _findScrollView() {
        let actor = this.get_parent();
        while (actor) {
            if (actor instanceof St.ScrollView)
                return actor;
            actor = actor.get_parent();
        }
        return null;
    }

    _isAtBottom() {
        const adjustment = this._findScrollView()?.vadjustment;
        if (!adjustment)
            return true;
        return adjustment.value + adjustment.page_size >= adjustment.upper - 96;
    }

    _scrollToBottom(shouldScroll) {
        if (!shouldScroll || this._scrollId)
            return;

        this._scrollId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scrollId = 0;
            const adjustment = this._findScrollView()?.vadjustment;
            if (adjustment)
                adjustment.value = Math.max(0, adjustment.upper - adjustment.page_size);
            return GLib.SOURCE_REMOVE;
        });
    }
});

/**
 * A compact second row that opens the saved-conversation list. Kept separate
 * from the answer row so clicking the answer opens that conversation instead.
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

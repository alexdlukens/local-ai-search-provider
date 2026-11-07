// SPDX-License-Identifier: GPL-3.0-or-later
// Preferences row helpers. They take a Gio.Settings and a container instead of
// a window, so the widget wiring can be exercised outside the shell process.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

/* Text entry bound to a string key plus a suffix button that drops the stored
 * override, letting the schema default apply again. The button stays
 * insensitive while the value is already the default, so the row never offers
 * a no-op. */
export function addResettableEntry(group, settings, key, title) {
    const row = new Adw.EntryRow({title});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);

    const resetButton = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        valign: Gtk.Align.CENTER,
    });
    resetButton.add_css_class('flat');

    const lowerTitle = title.toLowerCase();
    const sync = () => {
        const overridden = settings.get_user_value(key) !== null;
        const label = overridden
            ? `Restore the default ${lowerTitle}`
            : `Already using the default ${lowerTitle}`;
        resetButton.sensitive = overridden;
        resetButton.tooltip_text = label;
        resetButton.update_property([Gtk.AccessibleProperty.LABEL], [label]);
    };

    const clickedId = resetButton.connect('clicked', () => {
        settings.reset(key);
        sync();
    });
    const changedId = settings.connect(`changed::${key}`, sync);

    row.add_suffix(resetButton);
    sync();
    group.add(row);

    return {
        row,
        resetButton,
        destroy: () => {
            resetButton.disconnect(clickedId);
            settings.disconnect(changedId);
        },
    };
}

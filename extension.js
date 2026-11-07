// SPDX-License-Identifier: GPL-3.0-or-later
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AiSearchProvider} from './searchProvider.js';

export default class AiSearchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._provider = new AiSearchProvider(this, this._settings);
        Main.overview.searchController.addProvider(this._provider);
    }

    disable() {
        if (this._provider) {
            Main.overview.searchController.removeProvider(this._provider);
            this._provider.destroy();
            this._provider = null;
        }
        this._settings = null;
    }
}

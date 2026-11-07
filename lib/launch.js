// SPDX-License-Identifier: GPL-3.0-or-later
// Launch the chat window in its own process. Keeping GTK out of the shell
// process avoids mixing the GTK and Clutter main loops; GApplication makes
// repeated launches forward to the existing window instead of duplicating it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function launchChatWindow(extensionDir, {conversationId = null, history = false} = {}) {
    const gjs = GLib.find_program_in_path('gjs');
    if (!gjs)
        throw new Error('gjs was not found in PATH.');

    const script = GLib.build_filenamev([extensionDir, 'chatWindow.js']);
    const argv = [gjs, '-m', script];
    if (history)
        argv.push('--history');
    else if (conversationId)
        argv.push('--conversation', conversationId);

    const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
    process.wait_async(null, (proc, result) => {
        try {
            proc.wait_finish(result);
        } catch {
            // The window process exited
        }
    });
    return process;
}

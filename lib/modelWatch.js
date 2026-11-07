// Watches whether the selected model is resident on the server. A cold first
// request can take minutes while the server loads tens of gigabytes, and the
// models endpoint often reports that state before the chat stream emits
// anything. The watcher is best-effort: servers that do not advertise loaded
// state never produce a loading indication.

import GLib from 'gi://GLib';

const POLL_INTERVAL_MS = 900;

function isLoaded(entry) {
    if (!entry)
        return null;
    if (entry.loaded === true || entry.status === 'loaded')
        return true;
    if (entry.loaded === false || entry.status === 'unloaded' || entry.status === 'loading')
        return false;
    return null;
}

export class ModelWatch {
    /**
     * @param {object} options
     * @param {import('./openaiClient.js').OpenAIClient} options.client
     * @param {string} options.baseUrl
     * @param {string} options.apiKey
     * @param {string} options.model
     * @param {Gio.Cancellable} options.cancellable
     * @param {(state: {loading: boolean, loaded: boolean|null, fraction: number|null}) => void} options.onUpdate
     */
    constructor({client, baseUrl, apiKey, model, cancellable, onUpdate}) {
        this._client = client;
        this._baseUrl = baseUrl;
        this._apiKey = apiKey;
        this._model = model;
        this._cancellable = cancellable;
        this._onUpdate = onUpdate;

        this._stopped = false;
        this._timeoutId = 0;
        this._progressUnsupported = false;
    }

    start() {
        this._probe().catch(() => {});
    }

    stop() {
        if (this._stopped)
            return;
        this._stopped = true;
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    async _probe() {
        const models = await this._client.listModels({
            baseUrl: this._baseUrl,
            apiKey: this._apiKey,
            cancellable: this._cancellable,
        });
        if (this._stopped)
            return;

        const loaded = isLoaded(models.find(entry => entry.id === this._model));
        if (loaded !== false) {
            this._notify({loading: false, loaded, fraction: null});
            this.stop();
            return;
        }

        this._notify({loading: true, loaded: false, fraction: null});
        this._schedule();
    }

    _schedule() {
        if (this._stopped)
            return;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
            this._timeoutId = 0;
            this._poll().catch(() => {});
            return GLib.SOURCE_REMOVE;
        });
    }

    async _poll() {
        if (this._stopped)
            return;

        const [modelsResult, progressResult] = await Promise.allSettled([
            this._client.listModels({
                baseUrl: this._baseUrl,
                apiKey: this._apiKey,
                cancellable: this._cancellable,
            }),
            this._progressUnsupported
                ? Promise.resolve(null)
                : this._client.getLoadProgress({
                    baseUrl: this._baseUrl,
                    apiKey: this._apiKey,
                    cancellable: this._cancellable,
                }),
        ]);

        if (this._stopped)
            return;
        if (this._cancellable?.is_cancelled()) {
            this.stop();
            return;
        }

        const progress = progressResult.status === 'fulfilled'
            ? progressResult.value
            : null;
        if (!progress)
            this._progressUnsupported = true;

        const models = modelsResult.status === 'fulfilled'
            ? modelsResult.value
            : null;
        const loaded = models
            ? isLoaded(models.find(entry => entry.id === this._model))
            : null;

        // A finished mmap is enough; the chat stream starts on its own after
        // the server flips the model to loaded.
        if (loaded === true && progress?.phase !== 'mmap') {
            this._notify({loading: false, loaded: true, fraction: null});
            this.stop();
            return;
        }

        this._notify({
            loading: true,
            loaded: loaded ?? false,
            fraction: progress?.fraction ?? null,
        });
        this._schedule();
    }

    _notify(state) {
        if (this._stopped)
            return;
        this._onUpdate(state);
    }
}

export function formatModelState(state) {
    if (!state?.loading)
        return null;
    const fraction = state.fraction;
    if (fraction !== null && fraction > 0 && fraction < 1)
        return `Loading model… ${Math.round(fraction * 100)}%`;
    return 'Loading model…';
}

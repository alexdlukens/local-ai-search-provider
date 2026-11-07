// SPDX-License-Identifier: GPL-3.0-or-later
// Turn metrics for streaming chat completions (time to first token, prompt
// processing speed, generation speed, context usage).
//
// This module is deliberately plain JavaScript with no gi:// imports so it can
// be imported by GJS and by plain node for testing.

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finitePositive(value) {
    const number = finiteNumber(value);
    return number !== null && number > 0 ? number : null;
}

const TOKEN_FORMAT = new Intl.NumberFormat('en-US');
const ONE_DECIMAL_FORMAT = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1,
});
const TPS_FORMAT = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
});
const ZERO_DECIMAL_FORMAT = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
});

function formatTokens(value) {
    return TOKEN_FORMAT.format(value);
}

function formatTps(value) {
    return value >= 100
        ? ZERO_DECIMAL_FORMAT.format(value)
        : TPS_FORMAT.format(value);
}

/**
 * Accumulates streaming-generation metrics across one or more rounds.
 *
 * All timestamps are monotonic milliseconds. A "round" is one streamed model
 * call, including tool-call rounds.
 */
export class MetricsTracker {
    constructor() {
        this.reset();
    }

    reset() {
        this._startedAt = null;
        this._ttftMs = null;
        this._rounds = 0;
        this._round = null;

        this._promptTokens = 0;
        this._promptSeen = false;
        this._promptTpsWeighted = 0;
        this._promptTpsWeight = 0;

        this._genTokens = 0;
        this._genSeen = false;
        this._genTpsWeighted = 0;
        this._genTpsWeight = 0;

        this._contextTokens = null;
        this._estimated = false;
    }

    /**
     * Start a new generation round. Does not reset TTFT or accumulated totals.
     */
    beginRound(now) {
        const at = finiteNumber(now) ?? 0;
        if (this._startedAt === null)
            this._startedAt = at;

        this._rounds += 1;
        this._round = {
            startAt: at,
            firstTokenAt: null,
            endAt: null,
            chars: 0,
        };
    }

    /**
     * Record a streamed reasoning or content delta.
     */
    noteToken(now, {chars = 0} = {}) {
        const at = finiteNumber(now) ?? 0;
        if (!this._round)
            this.beginRound(at);

        if (this._round.firstTokenAt === null) {
            this._round.firstTokenAt = at;
            if (this._ttftMs === null)
                this._ttftMs = Math.max(0, at - this._startedAt);
        }

        const count = finiteNumber(chars);
        if (count !== null && count > 0)
            this._round.chars += count;
    }

    /**
     * Finish the current round and fold its numbers into the totals.
     */
    endRound(now, {usage = null, timings = null} = {}) {
        const round = this._round;
        if (!round)
            return;

        round.endAt = finiteNumber(now) ?? round.startAt;
        this._round = null;

        const reportedPrompt = finiteNumber(usage?.promptTokens);
        const reportedCompletion = finiteNumber(usage?.completionTokens);
        const reportedTotal = finiteNumber(usage?.totalTokens);
        const estimatedTokens = round.chars > 0
            ? Math.max(1, Math.round(round.chars / 4))
            : null;

        // Characters are the only fallback available when the server reports
        // no completion token count.
        const roundGenTokens = reportedCompletion ?? estimatedTokens;
        if (reportedCompletion === null && estimatedTokens !== null)
            this._estimated = true;

        let roundTotal = reportedTotal;
        if (roundTotal === null) {
            if (reportedPrompt !== null && roundGenTokens !== null)
                roundTotal = reportedPrompt + roundGenTokens;
            else if (roundGenTokens !== null)
                roundTotal = roundGenTokens;
        }

        if (reportedPrompt !== null) {
            this._promptSeen = true;
            this._promptTokens += reportedPrompt;
        }

        if (roundGenTokens !== null) {
            this._genSeen = true;
            this._genTokens += roundGenTokens;
        }

        const promptTps = this._roundPromptTps(round, reportedPrompt, timings);
        if (promptTps !== null && reportedPrompt !== 0) {
            const weight = reportedPrompt !== null && reportedPrompt > 0
                ? reportedPrompt
                : 1;
            this._promptTpsWeighted += promptTps * weight;
            this._promptTpsWeight += weight;
        }

        const genTps = this._roundGenTps(round, roundGenTokens, timings);
        if (genTps !== null && roundGenTokens !== null && roundGenTokens > 0) {
            this._genTpsWeighted += genTps * roundGenTokens;
            this._genTpsWeight += roundGenTokens;
        }

        // Context usage is always the last round's total.
        this._contextTokens = finiteNumber(roundTotal);
    }

    _roundPromptTps(round, promptTokens, timings) {
        const reported = finitePositive(timings?.promptTps);
        if (reported !== null)
            return reported;

        if (promptTokens === null || promptTokens <= 0 ||
            round.firstTokenAt === null || round.firstTokenAt <= round.startAt) {
            return null;
        }

        return finitePositive(
            promptTokens / (round.firstTokenAt - round.startAt) * 1000);
    }

    _roundGenTps(round, genTokens, timings) {
        // No streamed token means no measurable generation window.
        if (round.firstTokenAt === null)
            return null;

        const reported = finitePositive(timings?.genTps);
        if (reported !== null)
            return reported;

        if (genTokens === null || genTokens <= 0 ||
            round.endAt === null || round.endAt <= round.firstTokenAt) {
            return null;
        }

        return finitePositive(
            genTokens / (round.endAt - round.firstTokenAt) * 1000);
    }

    /**
     * Build a fresh metrics object. Safe to call at any time, including while
     * a round is still streaming and before a context window is known.
     */
    snapshot(now, {contextWindow = null} = {}) {
        const at = finiteNumber(now) ?? this._startedAt ?? 0;
        const elapsedMs = this._startedAt === null
            ? 0
            : Math.max(0, at - this._startedAt);

        const window = finitePositive(contextWindow);
        let contextPct = null;
        if (window !== null && this._contextTokens !== null) {
            contextPct = Math.round(
                this._contextTokens / window * 1000) / 10;
        }

        return {
            ttftMs: finiteNumber(this._ttftMs),
            elapsedMs,
            promptTokens: this._promptSeen ? this._promptTokens : null,
            promptTps: this._promptTpsWeight > 0
                ? finiteNumber(this._promptTpsWeighted / this._promptTpsWeight)
                : null,
            genTokens: this._genSeen ? this._genTokens : null,
            genTps: this._genTpsWeight > 0
                ? finiteNumber(this._genTpsWeighted / this._genTpsWeight)
                : null,
            contextTokens: finiteNumber(this._contextTokens),
            contextWindow: window,
            contextPct,
            estimated: this._estimated,
            rounds: this._rounds,
        };
    }
}

/**
 * Render a metrics object as a compact, human-readable string.
 * Returns '' when there is nothing worth showing.
 *
 * @param {object|null|undefined} metrics
 * @returns {string}
 */
export function formatMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object')
        return '';

    const segments = [];
    const estimated = metrics.estimated === true;

    const ttft = finiteNumber(metrics.ttftMs);
    if (ttft !== null) {
        segments.push(ttft < 1000
            ? `TTFT ${Math.round(ttft)} ms`
            : `TTFT ${(ttft / 1000).toFixed(2)} s`);
    }

    const promptTps = finiteNumber(metrics.promptTps);
    if (promptTps !== null)
        segments.push(`${estimated ? '~' : ''}prompt ${formatTps(promptTps)} tok/s`);

    const genTps = finiteNumber(metrics.genTps);
    if (genTps !== null)
        segments.push(`${estimated ? '~' : ''}gen ${formatTps(genTps)} tok/s`);

    const tokens = finiteNumber(metrics.contextTokens);
    if (tokens !== null) {
        const window = finitePositive(metrics.contextWindow);
        const tokenText = `${estimated ? '~' : ''}${formatTokens(tokens)}`;
        if (window !== null && finiteNumber(metrics.contextPct) !== null) {
            segments.push(
                `ctx ${ONE_DECIMAL_FORMAT.format(metrics.contextPct)}% ` +
                `(${tokenText} / ${formatTokens(window)} tok)`);
        } else {
            segments.push(`ctx ${tokenText} tok`);
        }
    }

    const rounds = finiteNumber(metrics.rounds);
    if (rounds !== null && rounds > 1)
        segments.push(`${rounds} rounds`);

    return segments.join(' · ');
}

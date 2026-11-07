// SPDX-License-Identifier: GPL-3.0-or-later
// Streaming chat loop shared by the overview search provider and the chat
// window. Handles model discovery, tool rounds, and the thinking switch so
// both surfaces behave identically.

import GLib from 'gi://GLib';

import {MetricsTracker} from './metrics.js';
import {executeTool, truncateToolResult} from './tools.js';

export const DEFAULT_SYSTEM_PROMPT =
    'You are a helpful AI assistant embedded in GNOME Shell. ' +
    'Answer in GitHub-flavored Markdown and be concise. ' +
    'Use headings, **bold**, *italic*, `inline code`, fenced code blocks with a language tag, ' +
    'lists, blockquotes, and tables when they make the answer clearer. ' +
    'Use the available tools when they help. ' +
    'Your training data has a cutoff, so NEVER state a current fact from memory. ' +
    'For anything time-sensitive (current events, office holders, prices, releases, versions, ' +
    'scores, statistics, "latest"/"today" questions), call a tool first: ' +
    'web_search for general or current information, fetch_url to read a result, ' +
    'search_wikipedia for encyclopedic facts, get_weather for weather, convert_currency for rates, ' +
    'get_country_info for country data, and get_datetime for the current date. ' +
    'Validate claims against tool results before answering, and prefer fresh tool data over memory. ' +
    'If the needed tool is unavailable or fails, say so plainly and note the answer may be out of date.';

export function buildMessages(systemPrompt, turns) {
    const messages = [{
        role: 'system',
        content: (systemPrompt ?? '').trim() || DEFAULT_SYSTEM_PROMPT,
    }];

    for (const turn of turns ?? []) {
        if (turn.role !== 'user' && turn.role !== 'assistant')
            continue;
        if (typeof turn.content !== 'string' || !turn.content.trim())
            continue;
        messages.push({role: turn.role, content: turn.content});
    }

    return messages;
}

function mergeUsage(prior, next) {
    return {
        promptTokens: next?.promptTokens ?? prior?.promptTokens ?? null,
        completionTokens: next?.completionTokens ?? prior?.completionTokens ?? null,
        totalTokens: next?.totalTokens ?? prior?.totalTokens ?? null,
    };
}

function mergeTimings(prior, next) {
    return {
        promptMs: next?.promptMs ?? prior?.promptMs ?? null,
        promptTps: next?.promptTps ?? prior?.promptTps ?? null,
        genMs: next?.genMs ?? prior?.genMs ?? null,
        genTps: next?.genTps ?? prior?.genTps ?? null,
    };
}

/**
 * Run one user turn, including any tool rounds.
 *
 * Yields:
 *   {type: 'model', model}
 *   {type: 'status', text}
 *   {type: 'reasoning', text}
 *   {type: 'content', text}
 *   {type: 'tool-result', name, text}
 *   {type: 'notice', text}
 *   {type: 'metrics', metrics}
 *   {type: 'done', metrics}
 *
 * Metrics are emitted alongside streamed text and once more before `done`,
 * which also carries the final snapshot.
 *
 * `messages` is mutated with tool-call and tool-result turns.
 */
export async function* runChat({
    client,
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    enableThinking,
    maxToolRounds,
    execute = executeTool,
    cancellable,
}) {
    if (!model) {
        model = await client.discoverModel({baseUrl, apiKey, cancellable});
        yield {type: 'model', model};
    }

    const now = () => GLib.get_monotonic_time() / 1000;

    let contextWindow = null;
    if (typeof client.getContextWindow === 'function') {
        client.getContextWindow({baseUrl, apiKey, model, cancellable})
            .then(value => {
                contextWindow = value;
            })
            .catch(() => {});
    }

    const tracker = new MetricsTracker();

    const toolsEnabled = Boolean(tools?.length);
    const rounds = Math.max(0, maxToolRounds ?? 0);
    let round = 0;
    let totalContent = '';

    const finish = async function* () {
        const metrics = tracker.snapshot(now(), {contextWindow});
        yield {type: 'metrics', metrics};
        yield {type: 'done', metrics};
    };

    while (true) {
        const roundContent = {text: ''};
        const toolCalls = [];
        let roundUsage = null;
        let roundTimings = null;

        tracker.beginRound(now());

        for await (const event of client.streamChat({
            baseUrl,
            apiKey,
            model,
            messages,
            tools: toolsEnabled ? tools : null,
            enableThinking,
            cancellable,
        })) {
            if (cancellable?.is_cancelled())
                return;

            switch (event.type) {
            case 'content': {
                tracker.noteToken(now(), {chars: event.text.length});
                roundContent.text += event.text;
                totalContent += event.text;
                yield {type: 'content', text: event.text};
                yield {
                    type: 'metrics',
                    metrics: tracker.snapshot(now(), {contextWindow}),
                };
                break;
            }
            case 'reasoning': {
                tracker.noteToken(now(), {chars: event.text.length});
                yield {type: 'reasoning', text: event.text};
                yield {
                    type: 'metrics',
                    metrics: tracker.snapshot(now(), {contextWindow}),
                };
                break;
            }
            case 'usage':
                roundUsage = mergeUsage(roundUsage, event.usage);
                roundTimings = mergeTimings(roundTimings, event.timings);
                break;
            case 'done':
                toolCalls.push(...(event.toolCalls ?? []));
                tracker.endRound(now(), {
                    usage: mergeUsage(roundUsage, event.usage),
                    timings: mergeTimings(roundTimings, event.timings),
                });
                break;
            }
        }

        if (cancellable?.is_cancelled())
            return;

        if (toolCalls.length === 0) {
            if (!totalContent.trim())
                yield {type: 'notice', text: '(The model returned an empty answer.)'};
            yield* finish();
            return;
        }

        if (!toolsEnabled) {
            yield {
                type: 'notice',
                text: '(The model requested a tool, but tools are disabled in preferences.)',
            };
            yield* finish();
            return;
        }

        if (round >= rounds) {
            yield {type: 'notice', text: '(Tool call limit reached.)'};
            yield* finish();
            return;
        }

        round += 1;
        const normalized = toolCalls.map((call, index) => ({
            id: call.id || `call_${round}_${index}`,
            type: 'function',
            function: {
                name: call.function.name,
                arguments: call.function.arguments || '{}',
            },
        }));

        messages.push({
            role: 'assistant',
            content: roundContent.text || null,
            tool_calls: normalized,
        });

        for (const call of normalized) {
            if (cancellable?.is_cancelled())
                return;

            yield {type: 'status', text: `Running ${call.function.name}…`};
            let result;
            try {
                result = await execute(
                    call.function.name,
                    call.function.arguments,
                    {cancellable});
            } catch (e) {
                if (cancellable?.is_cancelled())
                    return;
                result = `Tool error: ${e.message}`;
            }

            const text = truncateToolResult(result);
            yield {type: 'tool-result', name: call.function.name, text};
            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: text,
            });
        }

        yield {type: 'status', text: 'Thinking…'};
    }
}

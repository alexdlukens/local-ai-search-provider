// Streaming chat loop shared by the overview search provider and the chat
// window. Handles model discovery, tool rounds, and the thinking switch so
// both surfaces behave identically.

import {executeTool, truncateToolResult} from './tools.js';

export const DEFAULT_SYSTEM_PROMPT =
    'You are a helpful AI assistant embedded in GNOME Shell. ' +
    'Answer in GitHub-flavored Markdown and be concise. ' +
    'Use headings, **bold**, *italic*, `inline code`, fenced code blocks with a language tag, ' +
    'lists, blockquotes, and tables when they make the answer clearer. ' +
    'Use the available tools when they help.';

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
 *   {type: 'done'}
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

    const toolsEnabled = Boolean(tools?.length);
    const rounds = Math.max(0, maxToolRounds ?? 0);
    let round = 0;
    let totalContent = '';

    while (true) {
        const roundContent = {text: ''};
        const toolCalls = [];

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
            case 'content':
                roundContent.text += event.text;
                totalContent += event.text;
                yield {type: 'content', text: event.text};
                break;
            case 'reasoning':
                yield {type: 'reasoning', text: event.text};
                break;
            case 'done':
                toolCalls.push(...event.toolCalls);
                break;
            }
        }

        if (cancellable?.is_cancelled())
            return;

        if (toolCalls.length === 0) {
            if (!totalContent.trim())
                yield {type: 'notice', text: '(The model returned an empty answer.)'};
            yield {type: 'done'};
            return;
        }

        if (!toolsEnabled) {
            yield {
                type: 'notice',
                text: '(The model requested a tool, but tools are disabled in preferences.)',
            };
            yield {type: 'done'};
            return;
        }

        if (round >= rounds) {
            yield {type: 'notice', text: '(Tool call limit reached.)'};
            yield {type: 'done'};
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

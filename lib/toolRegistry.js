// Combines the built-in tools with tools discovered from configured MCP
// servers. Callers get both the OpenAI tool definitions and one execute
// function, so the chat loop does not need to know where a tool came from.

import {TOOL_DEFINITIONS, WEB_TOOL_DEFINITIONS, executeTool} from './tools.js';
import {parseMcpServers, listMcpTools, callMcpTool} from './mcp.js';

function sanitize(value) {
    return String(value ?? '')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 40) || 'tool';
}

function uniqueName(base, used) {
    let name = base.slice(0, 64);
    let index = 2;
    while (used.has(name)) {
        const suffix = `_${index}`;
        name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
        index += 1;
    }
    used.add(name);
    return name;
}

function mcpToolDefinition(server, tool, exposedName) {
    const schema = tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : {type: 'object', properties: {}};
    const description = String(tool.description ?? tool.title ?? 'MCP tool');
    return {
        type: 'function',
        function: {
            name: exposedName,
            description: `[${server.name}] ${description}`,
            parameters: schema,
        },
    };
}

/**
 * Build the tool set for one request.
 *
 * @param {Gio.Settings} settings
 * @param {{cancellable?: Gio.Cancellable,
 *          onStatus?: (text: string) => void}} [options]
 * @returns {Promise<{definitions: object[], execute: Function,
 *   warnings: string[], servers: number}>}
 */
export async function buildToolRegistry(settings, {cancellable, onStatus} = {}) {
    if (!settings.get_boolean('enable-tools')) {
        return {
            definitions: [],
            execute: async () => 'Error: tools are disabled.',
            warnings: [],
            servers: 0,
        };
    }

    const definitions = [...TOOL_DEFINITIONS];
    if (settings.get_boolean('enable-web-tools'))
        definitions.push(...WEB_TOOL_DEFINITIONS);

    const mapping = new Map();
    const usedNames = new Set(definitions.map(definition => definition.function.name));
    const warnings = [];
    let serverCount = 0;

    if (settings.get_boolean('enable-mcp')) {
        let servers = [];
        try {
            servers = parseMcpServers(settings.get_string('mcp-servers'))
                .filter(server => server.enabled);
        } catch (e) {
            warnings.push(e.message);
        }

        for (const server of servers) {
            onStatus?.(`Loading ${server.name} tools…`);
            try {
                const tools = await listMcpTools(server, {cancellable});
                serverCount += 1;

                for (const tool of tools) {
                    if (!tool?.name)
                        continue;
                    const exposed = uniqueName(
                        `mcp__${sanitize(server.name)}__${sanitize(tool.name)}`,
                        usedNames);
                    definitions.push(mcpToolDefinition(server, tool, exposed));
                    mapping.set(exposed, {server, toolName: tool.name});
                }
            } catch (e) {
                if (cancellable?.is_cancelled())
                    throw e;
                warnings.push(`${server.name}: ${e.message}`);
            }
        }
    }

    const execute = async (name, rawArguments, context = {}) => {
        const entry = mapping.get(name);
        if (!entry)
            return executeTool(name, rawArguments, context);

        let args = {};
        const raw = (rawArguments ?? '').trim();
        if (raw) {
            try {
                args = JSON.parse(raw);
            } catch (e) {
                return `Error: arguments for ${name} are not valid JSON (${e.message}).`;
            }
        }

        try {
            return await callMcpTool(
                entry.server, entry.toolName, args,
                {cancellable: context.cancellable});
        } catch (e) {
            if (context.cancellable?.is_cancelled())
                throw e;
            return `Error: ${e.message}`;
        }
    };

    return {definitions, execute, warnings, servers: serverCount};
}

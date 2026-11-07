// SPDX-License-Identifier: GPL-3.0-or-later
// Small, dependency-free Markdown renderer shared by the overview result row
// (Clutter/Pango) and the GTK chat window. The parser covers the subset local
// models produce in practice: headings, paragraphs, emphasis, inline code,
// fenced code, lists, blockquotes, rules and pipe tables.
//
// Everything is escaped before it reaches Pango markup, so model output cannot
// inject markup or link targets.

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;

const ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

export function escapeMarkup(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ENTITIES[ch]);
}

function sanitizeUrl(raw) {
    const value = String(raw ?? '').trim();
    if (/^(?:https?|mailto):/i.test(value))
        return value;
    return null;
}

function readEmphasis(source, i) {
    const ch = source[i];
    const double = source[i + 1] === ch;
    const marker = double ? ch + ch : ch;
    const start = i + marker.length;

    if (start >= source.length || /\s/.test(source[start]))
        return null;
    if (ch === '_' && i > 0 && /[\p{L}\p{N}]/u.test(source[i - 1]))
        return null;

    const end = source.indexOf(marker, start);
    if (end === -1 || end === start)
        return null;

    const inner = source.slice(start, end);
    if (!inner || /\s$/.test(inner))
        return null;
    if (ch === '_' && end + marker.length < source.length &&
        /[\p{L}\p{N}]/u.test(source[end + marker.length]))
        return null;

    return {tag: double ? 'b' : 'i', inner, next: end + marker.length};
}

// `mode` is 'anchor' for GTK labels (clickable links) and 'plain' for the
// overview row, where Pango links have no click handling.
function renderInline(text, mode) {
    const source = String(text ?? '');
    let out = '';
    let plain = '';
    let i = 0;

    const flush = () => {
        if (plain) {
            out += escapeMarkup(plain);
            plain = '';
        }
    };

    const emitLink = (label, url, next) => {
        flush();
        // A bare URL is its own label; rendering it recursively would find the
        // same URL again.
        const inner = label === url
            ? escapeMarkup(label)
            : renderInline(label, mode);
        out += mode === 'anchor'
            ? `<a href="${escapeMarkup(url)}">${inner}</a>`
            : `<u>${inner}</u>`;
        i = next;
    };

    while (i < source.length) {
        const ch = source[i];

        if (ch === '\\' && i + 1 < source.length) {
            plain += source[i + 1];
            i += 2;
            continue;
        }

        if (ch === '`') {
            let run = 1;
            while (source[i + run] === '`')
                run++;
            const fence = '`'.repeat(run);
            const end = source.indexOf(fence, i + run);
            if (end !== -1) {
                flush();
                let code = source.slice(i + run, end);
                if (code.length > 2 && code.startsWith(' ') && code.endsWith(' '))
                    code = code.slice(1, -1);
                out += `<tt>${escapeMarkup(code)}</tt>`;
                i = end + run;
                continue;
            }
        }

        if (ch === '~' && source[i + 1] === '~') {
            const end = source.indexOf('~~', i + 2);
            if (end !== -1 && end > i + 2) {
                flush();
                out += `<s>${renderInline(source.slice(i + 2, end), mode)}</s>`;
                i = end + 2;
                continue;
            }
        }

        if ((ch === '*' || ch === '_') &&
            source[i + 1] === ch && source[i + 2] === ch) {
            const triple = ch.repeat(3);
            const start = i + 3;
            const end = source.indexOf(triple, start);
            if (end !== -1 && end > start) {
                flush();
                out += `<b><i>${renderInline(source.slice(start, end), mode)}</i></b>`;
                i = end + 3;
                continue;
            }
        }

        if (ch === '*' || ch === '_') {
            const emphasis = readEmphasis(source, i);
            if (emphasis) {
                flush();
                out += `<${emphasis.tag}>${renderInline(emphasis.inner, mode)}</${emphasis.tag}>`;
                i = emphasis.next;
                continue;
            }
        }

        if (ch === '[') {
            const close = source.indexOf(']', i + 1);
            if (close !== -1 && source[close + 1] === '(') {
                const end = source.indexOf(')', close + 2);
                if (end !== -1) {
                    const url = sanitizeUrl(
                        source.slice(close + 2, end).trim().split(/\s+/)[0]);
                    if (url) {
                        emitLink(source.slice(i + 1, close), url, end + 1);
                        continue;
                    }
                }
            }
        }

        if (ch === '<') {
            const match = /^<((?:https?|mailto):[^>\s]+)>/i.exec(source.slice(i));
            if (match) {
                const url = sanitizeUrl(match[1]);
                if (url) {
                    emitLink(match[1], url, i + match[0].length);
                    continue;
                }
            }
        }

        if ((ch === 'h' || ch === 'H') &&
            /^https?:\/\//i.test(source.slice(i))) {
            const match = /^https?:\/\/[^\s<>"'`]+/i.exec(source.slice(i));
            if (match) {
                let url = match[0];
                while (/[.,;:!?)\]}]+$/.test(url))
                    url = url.slice(0, -1);
                if (url.length > 'https://'.length) {
                    emitLink(url, url, i + url.length);
                    continue;
                }
            }
        }

        plain += ch;
        i++;
    }

    flush();
    return out;
}

function splitTableRow(line) {
    let value = String(line ?? '').trim();
    if (value.startsWith('|'))
        value = value.slice(1);
    if (value.endsWith('|'))
        value = value.slice(0, -1);
    return value.split('|').map(cell => cell.trim());
}

function isTableStart(lines, i) {
    if (i + 1 >= lines.length || !lines[i].includes('|'))
        return false;
    const cells = splitTableRow(lines[i + 1]);
    return cells.length >= 2 &&
        cells.every(cell => /^:?-{1,}:?$/.test(cell.trim()));
}

function isBlockStart(lines, i) {
    const line = lines[i];
    if (!line || /^\s*$/.test(line))
        return true;
    if (FENCE.test(line) || HEADING.test(line) || RULE.test(line))
        return true;
    if (QUOTE.test(line) || LIST_ITEM.test(line))
        return true;
    return isTableStart(lines, i);
}

function parseList(lines, start) {
    const first = LIST_ITEM.exec(lines[start]);
    const ordered = /^\d/.test(first[2]);
    const items = [];
    let i = start;

    while (i < lines.length) {
        const match = LIST_ITEM.exec(lines[i]);
        if (!match || /^\d/.test(match[2]) !== ordered)
            break;

        const item = {text: match[3]};
        i++;

        // Indented continuation lines belong to the item above.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) &&
            !LIST_ITEM.test(lines[i]) && !FENCE.test(lines[i])) {
            item.text += ` ${lines[i].trim()}`;
            i++;
        }
        items.push(item);
    }

    const startNumber = ordered ? parseInt(first[2], 10) : 1;
    return {block: {type: 'list', ordered, start: startNumber, items}, next: i};
}

function parseTable(lines, start) {
    const header = splitTableRow(lines[start]);
    const aligns = splitTableRow(lines[start + 1]).map(cell => {
        const value = cell.trim();
        if (value.startsWith(':') && value.endsWith(':'))
            return 'center';
        if (value.endsWith(':'))
            return 'right';
        return 'left';
    });

    const rows = [];
    let i = start + 2;
    while (i < lines.length && lines[i].includes('|') &&
        !/^\s*$/.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
    }

    return {block: {type: 'table', header, aligns, rows}, next: i};
}

export function parseMarkdown(text) {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (/^\s*$/.test(line)) {
            i++;
            continue;
        }

        const fence = FENCE.exec(line);
        if (fence) {
            const marker = fence[1];
            const lang = fence[2] ?? '';
            const body = [];
            i++;
            while (i < lines.length &&
                !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
                body.push(lines[i]);
                i++;
            }
            if (i < lines.length)
                i++;
            blocks.push({type: 'code', lang, text: body.join('\n')});
            continue;
        }

        const heading = HEADING.exec(line);
        if (heading) {
            blocks.push({
                type: 'heading',
                level: heading[1].length,
                text: heading[2],
            });
            i++;
            continue;
        }

        if (RULE.test(line)) {
            blocks.push({type: 'rule'});
            i++;
            continue;
        }

        if (isTableStart(lines, i)) {
            const {block, next} = parseTable(lines, i);
            blocks.push(block);
            i = next;
            continue;
        }

        if (QUOTE.test(line)) {
            const parts = [];
            while (i < lines.length && QUOTE.test(lines[i])) {
                parts.push(lines[i].replace(QUOTE, ''));
                i++;
            }
            blocks.push({type: 'quote', text: parts.join('\n')});
            continue;
        }

        if (LIST_ITEM.test(line)) {
            const {block, next} = parseList(lines, i);
            blocks.push(block);
            i = next;
            continue;
        }

        const paragraph = [line.trim()];
        i++;
        while (i < lines.length && !isBlockStart(lines, i)) {
            paragraph.push(lines[i].trim());
            i++;
        }
        blocks.push({type: 'paragraph', text: paragraph.join('\n')});
    }

    return blocks;
}

function stripInline(text) {
    return String(text ?? '')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/~~(.*?)~~/g, '$1')
        .replace(/(?<![\p{L}\p{N}*])\*([^*\n]+)\*(?![\p{L}\p{N}*])/gu, '$1')
        .replace(/(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, '$1')
        .trim();
}

function padCell(value, width, align) {
    const missing = Math.max(0, width - value.length);
    if (align === 'right')
        return ' '.repeat(missing) + value;
    if (align === 'center') {
        const left = Math.floor(missing / 2);
        return ' '.repeat(left) + value + ' '.repeat(missing - left);
    }
    return value + ' '.repeat(missing);
}

function formatTable(block) {
    const rows = [block.header, ...block.rows];
    const columns = Math.max(...rows.map(row => row.length));
    const widths = [];

    for (let column = 0; column < columns; column++) {
        widths[column] = Math.max(1, ...rows.map(row =>
            stripInline(row[column] ?? '').length));
    }

    const formatRow = row => {
        const cells = [];
        for (let column = 0; column < columns; column++) {
            cells.push(padCell(
                stripInline(row[column] ?? ''),
                widths[column],
                block.aligns[column] ?? 'left'));
        }
        return cells.join(' │ ');
    };

    return [
        formatRow(block.header),
        widths.map(width => '─'.repeat(width)).join('─┼─'),
        ...block.rows.map(formatRow),
    ].join('\n');
}

const HEADING_SIZES = {
    1: 'x-large',
    2: 'large',
    3: 'medium',
    4: 'medium',
    5: 'medium',
    6: 'medium',
};

/**
 * Flatten Markdown into a single Pango markup string, for surfaces that render
 * one label (the overview result row).
 */
export function blocksToPango(text) {
    const blocks = parseMarkdown(text);
    const parts = [];

    for (const block of blocks) {
        switch (block.type) {
        case 'heading':
            parts.push(
                `<span weight="bold" size="${HEADING_SIZES[block.level] ?? 'medium'}">` +
                `${renderInline(block.text, 'plain')}</span>`);
            break;
        case 'paragraph':
            parts.push(renderInline(block.text.replace(/\n/g, ' '), 'plain'));
            break;
        case 'code':
            if (block.text)
                parts.push(`<span font_family="monospace">${escapeMarkup(block.text)}</span>`);
            break;
        case 'list':
            parts.push(block.items.map((item, index) => {
                const marker = block.ordered ? `${block.start + index}.` : '•';
                return `${marker} ${renderInline(item.text.replace(/\n/g, ' '), 'plain')}`;
            }).join('\n'));
            break;
        case 'quote':
            parts.push(block.text.split('\n').map(line =>
                line.trim() ? `▏ <i>${renderInline(line, 'plain')}</i>` : '').join('\n'));
            break;
        case 'rule':
            parts.push('──────────');
            break;
        case 'table':
            parts.push(
                `<span font_family="monospace">${escapeMarkup(formatTable(block))}</span>`);
            break;
        }
    }

    return parts.join('\n\n');
}

/**
 * Inline-only markup, used by the chat window's block widgets.
 */
export function inlineToPango(text, mode = 'anchor') {
    return renderInline(text, mode);
}

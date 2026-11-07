// Read-only tools exposed to the model through OpenAI function calling.
// Everything runs in the extension or chat-window process and returns data
// inline; the only side effect left is open_application.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

const HTTP_TIMEOUT_SECONDS = 20;
const COUNTRY_CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_TOOL_RESULT_CHARS = 8000;

const decoder = new TextDecoder('utf-8');

const httpSession = new Soup.Session({
    timeout: HTTP_TIMEOUT_SECONDS,
    idle_timeout: 10,
});

export const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'get_datetime',
            description: 'Get the current local date, time and timezone.',
            parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_system_info',
            description: 'Get basic information about this computer: OS, kernel, desktop, memory, CPU and uptime.',
            parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'open_application',
            description: 'Open an installed desktop application by name.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Application name, for example "Files" or "Firefox".',
                    },
                },
                required: ['query'],
                additionalProperties: false,
            },
        },
    },
];

export const WEB_TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'get_weather',
            description: 'Get current weather and a short daily forecast for a city or place. ' +
                'Returns temperature, conditions, humidity, wind and precipitation inline.',
            parameters: {
                type: 'object',
                properties: {
                    location: {
                        type: 'string',
                        description: 'City or place name, for example "Berlin" or "Austin, Texas".',
                    },
                    days: {
                        type: 'integer',
                        description: 'Number of forecast days (1-5). Default 3.',
                        minimum: 1,
                        maximum: 5,
                    },
                },
                required: ['location'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_country_info',
            description: 'Look up a country: latest population, capital, region, income level, ' +
                'and a short Wikipedia summary. Use this for questions such as "population of Germany".',
            parameters: {
                type: 'object',
                properties: {
                    country: {
                        type: 'string',
                        description: 'Country name or ISO code, for example "Germany" or "DEU".',
                    },
                },
                required: ['country'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_wikipedia',
            description: 'Search Wikipedia and return article summaries with links. ' +
                'Use for general facts, history, people and background information.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search terms.',
                    },
                    limit: {
                        type: 'integer',
                        description: 'Number of results (1-5). Default 3.',
                        minimum: 1,
                        maximum: 5,
                    },
                    language: {
                        type: 'string',
                        description: 'Wikipedia language code, for example "en" or "de". Default en.',
                    },
                },
                required: ['query'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'convert_currency',
            description: 'Convert an amount between currencies using current reference exchange rates.',
            parameters: {
                type: 'object',
                properties: {
                    amount: {
                        type: 'number',
                        description: 'Amount to convert. Default 1.',
                    },
                    from: {
                        type: 'string',
                        description: 'Source currency code, for example "USD".',
                    },
                    to: {
                        type: 'string',
                        description: 'Target currency code, for example "EUR".',
                    },
                },
                required: ['from', 'to'],
                additionalProperties: false,
            },
        },
    },
];

// --- HTTP helpers ----------------------------------------------------------

function sendAndRead(message, cancellable) {
    return new Promise((resolve, reject) => {
        httpSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable ?? null,
            (session, result) => {
                try {
                    resolve(session.send_and_read_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

async function fetchJson(url, {cancellable} = {}) {
    const message = Soup.Message.new('GET', url);
    if (!message)
        throw new Error(`Invalid URL: ${url}`);

    message.request_headers.append('Accept', 'application/json');
    message.request_headers.append('Accept-Language', 'en-US,en');
    message.request_headers.append('User-Agent', 'gnome-ai-search/0.2');

    const bytes = await sendAndRead(message, cancellable);
    const status = message.get_status();
    const body = decoder.decode(bytes.get_data());

    if (status < 200 || status >= 300) {
        const detail = body.trim().slice(0, 300);
        throw new Error(`HTTP ${status}${detail ? `: ${detail}` : ''}`);
    }

    try {
        return JSON.parse(body);
    } catch {
        throw new Error('The service returned invalid JSON');
    }
}

function shorten(text, limit) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function formatNumber(value, digits = 0) {
    if (value === null || value === undefined || value === '')
        return '';
    const number = Number(value);
    if (!Number.isFinite(number))
        return String(value);
    return new Intl.NumberFormat('en-US', {
        maximumFractionDigits: digits,
    }).format(number);
}

// --- Local tools -----------------------------------------------------------

function readFile(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(contents) : '';
    } catch {
        return '';
    }
}

function memorySummary() {
    const info = readFile('/proc/meminfo');
    const totalKb = Number(info.match(/^MemTotal:\s+(\d+)/m)?.[1] ?? 0);
    const availableKb = Number(info.match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? 0);
    if (!totalKb)
        return null;
    const toGiB = kb => (kb / 1024 / 1024).toFixed(1);
    return `${toGiB(totalKb - availableKb)} GiB used of ${toGiB(totalKb)} GiB`;
}

function cpuSummary() {
    const info = readFile('/proc/cpuinfo');
    return info.match(/^model name\s*:\s*(.+)$/m)?.[1]?.trim() ?? null;
}

function uptimeSummary() {
    const info = readFile('/proc/uptime');
    const seconds = Number(info.split(/\s+/)[0] ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0)
        return null;
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (days)
        parts.push(`${days}d`);
    parts.push(`${hours}h`, `${minutes}m`);
    return parts.join(' ');
}

function formatDateTime() {
    const now = GLib.DateTime.new_now_local();
    return now.format('%A, %B %-e, %Y at %H:%M:%S %Z (%z)');
}

let _shellVersion;

function shellVersion() {
    if (_shellVersion !== undefined)
        return _shellVersion;
    _shellVersion = null;
    try {
        const [ok, out] = GLib.spawn_command_line_sync('gnome-shell --version');
        if (ok) {
            const match = new TextDecoder().decode(out).trim()
                .match(/(\d+(?:\.\d+)*)/);
            if (match)
                _shellVersion = match[1];
        }
    } catch {
        // Not a GNOME Shell session
    }
    return _shellVersion;
}

function systemInfo() {
    const lines = [];
    const osName = GLib.get_os_info('PRETTY_NAME') || GLib.get_os_info('NAME');
    if (osName)
        lines.push(`OS: ${osName}`);
    lines.push(`Hostname: ${GLib.get_host_name()}`);
    lines.push(`User: ${GLib.get_user_name()}`);
    const shell = shellVersion();
    if (shell)
        lines.push(`GNOME Shell: ${shell}`);

    const session = [GLib.getenv('XDG_SESSION_TYPE'), GLib.getenv('XDG_CURRENT_DESKTOP')]
        .filter(Boolean).join(', ');
    if (session)
        lines.push(`Session: ${session}`);

    const cpu = cpuSummary();
    if (cpu)
        lines.push(`CPU: ${cpu}`);
    const memory = memorySummary();
    if (memory)
        lines.push(`Memory: ${memory}`);
    const uptime = uptimeSummary();
    if (uptime)
        lines.push(`Uptime: ${uptime}`);

    return lines.join('\n');
}

function findApplication(search) {
    const needle = search.toLowerCase();
    let partial = null;

    for (const info of Gio.AppInfo.get_all()) {
        if (!info.should_show())
            continue;

        const id = info.get_id()?.replace(/\.desktop$/i, '');
        const names = [info.get_name(), info.get_display_name(), id]
            .filter(Boolean)
            .map(value => value.toLowerCase());

        if (names.includes(needle))
            return info;
        if (!partial && names.some(value =>
            value.includes(needle) || needle.includes(value)))
            partial = info;
    }

    return partial;
}

function openApplication(query) {
    const search = (query ?? '').trim();
    if (!search)
        return 'Error: no application name was given.';

    try {
        const app = findApplication(search);
        if (!app)
            return `No installed application matching "${search}" was found.`;

        const context = globalThis.global?.create_app_launch_context?.(0, -1) ?? null;
        if (!app.launch([], context))
            return `Could not launch ${app.get_name()}.`;
        return `Opened ${app.get_name()}.`;
    } catch (e) {
        return `Could not open "${search}": ${e.message}`;
    }
}

// --- Weather ---------------------------------------------------------------

const WEATHER_CODES = new Map([
    [0, 'clear sky'],
    [1, 'mainly clear'],
    [2, 'partly cloudy'],
    [3, 'overcast'],
    [45, 'fog'],
    [48, 'depositing rime fog'],
    [51, 'light drizzle'],
    [53, 'moderate drizzle'],
    [55, 'dense drizzle'],
    [56, 'light freezing drizzle'],
    [57, 'dense freezing drizzle'],
    [61, 'slight rain'],
    [63, 'moderate rain'],
    [65, 'heavy rain'],
    [66, 'light freezing rain'],
    [67, 'heavy freezing rain'],
    [71, 'slight snow'],
    [73, 'moderate snow'],
    [75, 'heavy snow'],
    [77, 'snow grains'],
    [80, 'slight rain showers'],
    [81, 'moderate rain showers'],
    [82, 'violent rain showers'],
    [85, 'slight snow showers'],
    [86, 'heavy snow showers'],
    [95, 'thunderstorm'],
    [96, 'thunderstorm with slight hail'],
    [99, 'thunderstorm with heavy hail'],
]);

function weatherDescription(code) {
    return WEATHER_CODES.get(Number(code)) ?? `weather code ${code}`;
}

async function getWeather(args, ctx) {
    const location = String(args.location ?? '').trim();
    if (!location)
        throw new Error('A location is required.');

    const days = Math.min(5, Math.max(1, Number(args.days) || 3));
    const geocode = await fetchJson(
        'https://geocoding-api.open-meteo.com/v1/search?' +
        `name=${encodeURIComponent(location)}&count=1&language=en&format=json`,
        ctx);
    const place = geocode?.results?.[0];
    if (!place)
        throw new Error(`No location matching "${location}" was found.`);

    const forecast = await fetchJson(
        'https://api.open-meteo.com/v1/forecast?' +
        `latitude=${place.latitude}&longitude=${place.longitude}` +
        '&current=temperature_2m,relative_humidity_2m,apparent_temperature,' +
        'precipitation,weather_code,wind_speed_10m' +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min,' +
        'precipitation_probability_max' +
        `&timezone=auto&forecast_days=${days}`,
        ctx);

    const current = forecast.current ?? {};
    const admin = place.admin1 &&
        place.admin1 !== place.name &&
        !place.admin1.toLowerCase().includes(place.name.toLowerCase())
        ? place.admin1
        : null;
    const label = [place.name, admin, place.country]
        .filter(Boolean)
        .join(', ');

    const lines = [
        `${label} — now ${formatNumber(current.temperature_2m, 1)} °C ` +
        `(feels like ${formatNumber(current.apparent_temperature, 1)} °C), ` +
        `${weatherDescription(current.weather_code)}`,
        `Humidity ${formatNumber(current.relative_humidity_2m)}%, ` +
        `wind ${formatNumber(current.wind_speed_10m, 1)} km/h, ` +
        `precipitation ${formatNumber(current.precipitation, 1)} mm.`,
    ];

    const daily = forecast.daily ?? {};
    for (let i = 0; i < Math.min(days, daily.time?.length ?? 0); i++) {
        const date = GLib.DateTime.new_from_iso8601(
            `${daily.time[i]}T00:00:00`, GLib.TimeZone.new_utc());
        const dayLabel = i === 0
            ? 'Today'
            : (date ? date.format('%A') : daily.time[i]);
        const probability = daily.precipitation_probability_max?.[i];
        lines.push(
            `${dayLabel} (${daily.time[i]}): ` +
            `${formatNumber(daily.temperature_2m_min?.[i], 1)}–` +
            `${formatNumber(daily.temperature_2m_max?.[i], 1)} °C, ` +
            `${weatherDescription(daily.weather_code?.[i])}` +
            (probability === null || probability === undefined
                ? ''
                : `, ${formatNumber(probability)}% precipitation`));
    }

    lines.push(`Timezone: ${forecast.timezone ?? 'local'}.`);
    return lines.join('\n');
}

// --- Countries and population ---------------------------------------------

let _countryCache = null;

function normalizeName(value) {
    return String(value ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

async function worldBankCountries(ctx) {
    if (_countryCache && Date.now() - _countryCache.fetchedAt < COUNTRY_CACHE_MS)
        return _countryCache.countries;

    const payload = await fetchJson(
        'https://api.worldbank.org/v2/country?format=json&per_page=400', ctx);
    const entries = Array.isArray(payload?.[1]) ? payload[1] : [];
    const countries = entries.filter(entry => entry?.region?.value !== 'Aggregates');
    _countryCache = {fetchedAt: Date.now(), countries};
    return countries;
}

function matchCountry(countries, query) {
    const needle = normalizeName(query);
    if (!needle)
        return null;

    const exact = countries.find(country =>
        normalizeName(country.name) === needle ||
        normalizeName(country.iso2Code) === needle ||
        normalizeName(country.id) === needle);
    if (exact)
        return exact;

    return countries.find(country => {
        const name = normalizeName(country.name);
        return name.includes(needle) || needle.includes(name);
    }) ?? null;
}

async function worldBankPopulation(country, ctx) {
    const payload = await fetchJson(
        `https://api.worldbank.org/v2/country/${encodeURIComponent(country.id)}` +
        '/indicator/SP.POP.TOTL?format=json&per_page=10', ctx);
    const rows = Array.isArray(payload?.[1]) ? payload[1] : [];
    const latest = rows
        .filter(row => row?.value !== null && row?.value !== undefined)
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    return latest ? {value: latest.value, year: latest.date} : null;
}

async function wikipediaSummary(title, language, ctx) {
    const lang = String(language ?? 'en').toLowerCase().replace(/[^a-z-]/g, '') || 'en';
    return fetchJson(
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/` +
        encodeURIComponent(title), ctx);
}

async function getCountryInfo(args, ctx) {
    const query = String(args.country ?? '').trim();
    if (!query)
        throw new Error('A country name or code is required.');

    const lines = [];
    let wiki = null;
    let country = null;

    try {
        const countries = await worldBankCountries(ctx);
        country = matchCountry(countries, query);
    } catch {
        // Population lookup is best-effort
    }

    try {
        wiki = await wikipediaSummary(country?.name ?? query, 'en', ctx);
    } catch {
        // Fall back to a Wikipedia search
        try {
            const results = await searchWikipediaResults(query, 1, 'en', ctx);
            if (results[0])
                wiki = await wikipediaSummary(results[0].title, 'en', ctx);
        } catch {
            // No summary available
        }
    }

    const title = country?.name ?? wiki?.title ?? query;
    lines.push(country ? `${title} (${country.id})` : title);

    if (country) {
        try {
            const population = await worldBankPopulation(country, ctx);
            if (population) {
                lines.push(`Population: ${formatNumber(population.value)} ` +
                    `(World Bank, ${population.year})`);
            }
        } catch {
            // Leave population out
        }
        if (country.capitalCity)
            lines.push(`Capital: ${country.capitalCity}`);
        if (country.region?.value)
            lines.push(`Region: ${country.region.value.trim()}`);
        if (country.incomeLevel?.value)
            lines.push(`Income level: ${country.incomeLevel.value}`);
    }

    if (wiki?.extract)
        lines.push('', shorten(wiki.extract, 700));
    if (wiki?.content_urls?.desktop?.page)
        lines.push('', `Source: ${wiki.content_urls.desktop.page}`);

    return lines.join('\n');
}

// --- Wikipedia -------------------------------------------------------------

async function searchWikipediaResults(query, limit, language, ctx) {
    const lang = String(language ?? 'en').toLowerCase().replace(/[^a-z-]/g, '') || 'en';
    const payload = await fetchJson(
        `https://${lang}.wikipedia.org/w/api.php?action=query&list=search` +
        `&srsearch=${encodeURIComponent(query)}&format=json&utf8=1` +
        `&srlimit=${limit}&origin=*`, ctx);

    return (payload?.query?.search ?? [])
        .map(result => ({title: result.title, snippet: result.snippet ?? ''}))
        .filter(result => result.title);
}

async function searchWikipedia(args, ctx) {
    const query = String(args.query ?? '').trim();
    if (!query)
        throw new Error('A search query is required.');

    const limit = Math.min(5, Math.max(1, Number(args.limit) || 3));
    const language = String(args.language ?? 'en');
    const results = await searchWikipediaResults(query, limit, language, ctx);
    if (results.length === 0)
        return `No Wikipedia results for "${query}".`;

    const summaries = await Promise.allSettled(results.map(result =>
        wikipediaSummary(result.title, language, ctx)));

    const lines = [];
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const summary = summaries[i].status === 'fulfilled'
            ? summaries[i].value
            : null;
        const lang = String(language ?? 'en').toLowerCase().replace(/[^a-z-]/g, '') || 'en';
        const url = summary?.content_urls?.desktop?.page ??
            `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(result.title.replace(/ /g, '_'))}`;

        lines.push(`${i + 1}. ${result.title}`);
        if (summary?.extract)
            lines.push(shorten(summary.extract, 500));
        lines.push(url);
        if (i < results.length - 1)
            lines.push('');
    }

    return lines.join('\n');
}

// --- Currency --------------------------------------------------------------

async function convertCurrency(args, ctx) {
    const from = String(args.from ?? '').trim().toUpperCase();
    const to = String(args.to ?? '').trim().toUpperCase();
    const amount = Number(args.amount ?? 1);

    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to))
        throw new Error('Currency codes must be three letters, for example USD or EUR.');
    if (!Number.isFinite(amount) || amount < 0)
        throw new Error('The amount must be a non-negative number.');

    if (from === to)
        return `${formatNumber(amount, 2)} ${from} = ${formatNumber(amount, 2)} ${to}`;

    const payload = await fetchJson(
        `https://api.frankfurter.dev/v1/latest?from=${from}&to=${to}`, ctx);
    const rate = payload?.rates?.[to];
    if (!Number.isFinite(rate))
        throw new Error(`No exchange rate for ${from}/${to}.`);

    return `${formatNumber(amount, 2)} ${from} = ` +
        `${formatNumber(amount * rate, 2)} ${to} ` +
        `(rate ${formatNumber(rate, 5)}, ${payload.date ?? 'latest'})`;
}

// --- Dispatch --------------------------------------------------------------

/**
 * Execute a tool call from the model.
 *
 * @param {string} name tool name
 * @param {string} rawArguments JSON-encoded arguments
 * @param {{cancellable?: Gio.Cancellable}} [context]
 * @returns {Promise<string>} result text sent back to the model
 */
export async function executeTool(name, rawArguments, context = {}) {
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
        switch (name) {
        case 'get_datetime':
            return formatDateTime();
        case 'get_system_info':
            return systemInfo();
        case 'open_application':
            return openApplication(args.query);
        case 'get_weather':
            return await getWeather(args, context);
        case 'get_country_info':
            return await getCountryInfo(args, context);
        case 'search_wikipedia':
            return await searchWikipedia(args, context);
        case 'convert_currency':
            return await convertCurrency(args, context);
        default:
            return `Error: unknown tool "${name}".`;
        }
    } catch (e) {
        if (context.cancellable?.is_cancelled())
            throw e;
        return `Error: ${e.message}`;
    }
}

export {MAX_TOOL_RESULT_CHARS};

export function truncateToolResult(text) {
    const value = String(text ?? '');
    if (value.length <= MAX_TOOL_RESULT_CHARS)
        return value;
    return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (truncated)`;
}

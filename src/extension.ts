import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';

type TimeFormat = 
    | 'hours' 
    | 'h' 
    | 'hm' 
    | 'hoursMinutes' 
    | 'hoursAndMinutes' 
    | 'decimalHours' 
    | 'decimalH' 
    | 'codingHoursMinutes' 
    | 'codingHours' 
    | 'codingDecimalHours';
type LangMap = { [lang: string]: number };
type DailyMap = { [date: string]: LangMap };

interface StatsFile {
    version: 2;
    languages: LangMap;
    daily: DailyMap;
}

interface MenuItem extends vscode.QuickPickItem {
    id?: string;
}

interface RangeItem extends vscode.QuickPickItem {
    days?: number;
    daily?: boolean;
}

type TrackState = 'tracking' | 'paused' | 'idle' | 'unfocused' | 'ignored' | 'none';

const SECRET_KEY = 'codetime.discordBotToken';
const DEFAULT_STATS_PATH = path.join(os.homedir(), 'CodeTime-langtimes.json');
const IGNORED_SCHEMES = ['output', 'debug', 'git', 'gitfs', 'comment', 'vscode-terminal'];

const DEVICON_BASE = 'https://raw.githubusercontent.com/YigitCahit/CodeTime-Icons/refs/heads/main';
const DEFAULT_FALLBACK_ICON = `${DEVICON_BASE}/default.png`;

// VS Code languageId / görünen ad (küçük harf, boşluksuz) -> devicon yolu
const DEVICON_MAP: { [key: string]: string } = {
    python: 'python',
    javascript: 'javascript',
    javascriptreact: 'react',
    typescript: 'typescript',
    typescriptreact: 'react',
    java: 'java',
    csharp: 'csharp',
    'c#': 'csharp',
    cpp: 'cplusplus',
    'c++': 'cplusplus',
    c: 'c',
    go: 'go',
    rust: 'rust',
    php: 'php',
    ruby: 'ruby',
    html: 'html5',
    css: 'css3',
    scss: 'sass',
    sass: 'sass',
    less: 'less-plain-wordmark',
    json: 'json',
    jsonc: 'json',
    markdown: 'markdown',
    shellscript: 'bash',
    bash: 'bash',
    powershell: 'powershell',
    kotlin: 'kotlin',
    swift: 'swift',
    dart: 'dart',
    lua: 'lua',
    r: 'r',
    perl: 'perl',
    scala: 'scala',
    haskell: 'haskell',
    elixir: 'elixir',
    yaml: 'yaml',
    dockerfile: 'docker',
    vue: 'vuejs',
    svelte: 'svelte',
    sql: 'azuresqldatabase',
    groovy: 'groovy',
    objectivec: 'objectivec',
    fsharp: 'fsharp',
    julia: 'julia',
    zig: 'zig'
};

let ctx: vscode.ExtensionContext;
let output: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem | undefined;

let stats: StatsFile = emptyStats();
let pending: DailyMap = {};

let currentLanguage: string | undefined;
let lastTick = Date.now();
let lastActivity = Date.now();
let windowFocused = true;
let paused = false;
let dirty = false;
let sending = false;
let tickCount = 0;
let lastSync: Date | undefined;
let lastErrorNotice = 0;

let tickTimer: NodeJS.Timeout | undefined;
let saveTimer: NodeJS.Timeout | undefined;
let syncTimer: NodeJS.Timeout | undefined;

function cfg() {
    return vscode.workspace.getConfiguration('codetime');
}

function getSetting<T>(key: string, def: T): T {
    return cfg().get<T>(key, def);
}

function log(msg: string) {
    output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function emptyStats(): StatsFile {
    return { version: 2, languages: {}, daily: {} };
}

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

function dateKey(offsetDays = 0): string {
    const d = new Date();
    d.setDate(d.getDate() - offsetDays);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sumValues(m: LangMap): number {
    return Object.values(m).reduce((a, b) => a + b, 0);
}

function formatDuration(seconds: number, fmt: TimeFormat): string {
    const s = Math.max(0, seconds);
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const decimalHVal = (s / 3600).toFixed(1);

    switch (fmt) {
        case 'h':
            return `${hours}h`;
        case 'hm': {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            return h > 0 ? `${h}h ${m}m` : `${m}m`;
        }
        case 'hoursMinutes': {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            return h > 0 ? `${h} Hours ${m} Minutes` : `${m} Minutes`;
        }
        case 'hoursAndMinutes': {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            if (h > 0 && m > 0) { return `${h} hours and ${m} minutes`; }
            if (h > 0) { return `${h} hours`; }
            return `${m} minutes`;
        }
        case 'decimalH':
            return `${decimalHVal}h`;
        case 'decimalHours':
            return `${decimalHVal} Hours`;
        case 'codingHoursMinutes': {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            if (h > 0 && m > 0) { return `Coding for ${h} hours and ${m} minutes`; }
            if (h > 0) { return `Coding for ${h} hours`; }
            return `Coding for ${m} minutes`;
        }
        case 'codingHours': {
            const h = s <= 0 ? 0 : Math.max(1, Math.round(s / 3600));
            return `Coding for ${h} hours`;
        }
        case 'codingDecimalHours':
            return `Coding for ${decimalHVal} hours`;
        case 'hours':
        default: {
            const h = s <= 0 ? 0 : Math.max(1, Math.round(s / 3600));
            return `${h} Hours`;
        }
    }
}

function uiFmt(seconds: number): string {
    return formatDuration(seconds, getSetting<TimeFormat>('display.timeFormat', 'hoursMinutes'));
}

function bar(pct: number): string {
    const filled = Math.round((pct / 100) * 20);
    return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)}  ${pct.toFixed(1)}%`;
}

function displayName(lang: string): string {
    const aliases = getSetting<{ [k: string]: string }>('languageAliases', {});
    return aliases[lang] || lang;
}

function aggregate(map: LangMap): [string, number][] {
    const out: LangMap = {};
    for (const [lang, sec] of Object.entries(map)) {
        const name = displayName(lang);
        out[name] = (out[name] || 0) + sec;
    }
    return Object.entries(out).sort((a, b) => b[1] - a[1]);
}

function iconUrl(lang: string | undefined): string {
    const fallback = getSetting<string>('discord.fallbackIconUrl', DEFAULT_FALLBACK_ICON).trim() || DEFAULT_FALLBACK_ICON;
    if (!lang) { return fallback; }

    const key = lang.toLowerCase().replace(/\s+/g, '');

    // Kullanıcı özel ikon tanımlamışsa öncelik onda
    const overrides = getSetting<{ [k: string]: string }>('discord.iconOverrides', {});
    if (overrides[lang]) { return overrides[lang]; }
    if (overrides[key]) { return overrides[key]; }

    const entry = DEVICON_MAP[key];
    return entry ? `${DEVICON_BASE}/${entry}.png` : fallback;
}

function notify(kind: 'info' | 'warn' | 'error', msg: string, ...actions: string[]): Thenable<string | undefined> {
    const level = getSetting<string>('notifications', 'all');
    if (level === 'none') { return Promise.resolve(undefined); }
    if (level === 'errors' && kind === 'info') { return Promise.resolve(undefined); }
    const text = `CodeTime: ${msg}`;
    if (kind === 'error') { return vscode.window.showErrorMessage(text, ...actions); }
    if (kind === 'warn') { return vscode.window.showWarningMessage(text, ...actions); }
    return vscode.window.showInformationMessage(text, ...actions);
}

function getStatsPath(): string {
    let p = getSetting<string>('statsFilePath', '').trim();
    if (!p) { return DEFAULT_STATS_PATH; }
    if (p.startsWith('~')) { p = path.join(os.homedir(), p.slice(1)); }
    return p;
}

function cleanMap(v: any): LangMap {
    const r: LangMap = {};
    if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) {
            const n = Number(v[k]);
            if (isFinite(n) && n > 0) { r[k] = n; }
        }
    }
    return r;
}

function normalizeStats(raw: any): StatsFile {
    const out = emptyStats();
    if (!raw || typeof raw !== 'object') { return out; }
    if (raw.version === 2) {
        out.languages = cleanMap(raw.languages);
        if (raw.daily && typeof raw.daily === 'object') {
            for (const d of Object.keys(raw.daily)) { out.daily[d] = cleanMap(raw.daily[d]); }
        }
    } else {
        out.languages = cleanMap(raw);
    }
    return out;
}

function readStatsFile(): StatsFile {
    const p = getStatsPath();
    if (!fs.existsSync(p)) { return emptyStats(); }
    const text = fs.readFileSync(p, 'utf-8').trim();
    if (!text) { return emptyStats(); }
    return normalizeStats(JSON.parse(text));
}

function writeStatsFile(s: StatsFile) {
    const p = getStatsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
}

function saveStats(): boolean {
    try {
        const fresh = readStatsFile();
        const hasPending = Object.keys(pending).length > 0;

        if (hasPending) {
            for (const [date, langs] of Object.entries(pending)) {
                const day = fresh.daily[date] || (fresh.daily[date] = {});
                for (const [lang, sec] of Object.entries(langs)) {
                    const r = Math.round(sec * 10) / 10;
                    fresh.languages[lang] = (fresh.languages[lang] || 0) + r;
                    day[lang] = (day[lang] || 0) + r;
                }
            }
            const keepDays = Math.max(7, getSetting<number>('dailyHistoryDays', 90));
            const cutoff = dateKey(keepDays - 1);
            for (const d of Object.keys(fresh.daily)) {
                if (d < cutoff) { delete fresh.daily[d]; }
            }
            writeStatsFile(fresh);
            pending = {};
        }
        stats = fresh;
        return true;
    } catch (e) {
        log(`Kaydetme hatası: ${errMsg(e)}`);
        return false;
    }
}

function mutateStats(fn: (s: StatsFile) => void): boolean {
    if (!saveStats()) { return false; }
    try {
        const fresh = readStatsFile();
        fn(fresh);
        writeStatsFile(fresh);
        stats = fresh;
        dirty = true;
        return true;
    } catch (e) {
        log(`Veri güncelleme hatası: ${errMsg(e)}`);
        return false;
    }
}

function getDailyMerged(): DailyMap {
    const merged: DailyMap = {};
    for (const [d, m] of Object.entries(stats.daily)) { merged[d] = { ...m }; }
    for (const [d, m] of Object.entries(pending)) {
        const day = merged[d] || (merged[d] = {});
        for (const [l, s] of Object.entries(m)) { day[l] = (day[l] || 0) + s; }
    }
    return merged;
}

function getRange(days: number): LangMap {
    const out: LangMap = {};
    if (days === 0) {
        for (const [l, s] of Object.entries(stats.languages)) { out[l] = s; }
        for (const m of Object.values(pending)) {
            for (const [l, s] of Object.entries(m)) { out[l] = (out[l] || 0) + s; }
        }
        return out;
    }
    const cutoff = dateKey(days - 1);
    for (const [d, m] of Object.entries(getDailyMerged())) {
        if (d < cutoff) { continue; }
        for (const [l, s] of Object.entries(m)) { out[l] = (out[l] || 0) + s; }
    }
    return out;
}

function markActivity() {
    lastActivity = Date.now();
}

function isTrackable(doc: vscode.TextDocument): boolean {
    return !IGNORED_SCHEMES.includes(doc.uri.scheme);
}

function computeState(): TrackState {
    if (paused) { return 'paused'; }
    if (!currentLanguage) { return 'none'; }
    if (getSetting<string[]>('ignoredLanguages', []).includes(currentLanguage)) { return 'ignored'; }
    const mode = getSetting<string>('trackingMode', 'active');
    if (mode === 'passive') {
        return 'tracking';
    }
    if (getSetting<boolean>('pauseWhenWindowUnfocused', true) && !windowFocused) { return 'unfocused'; }
    const idle = getSetting<number>('idleTimeoutSeconds', 300);
    if (idle > 0 && Date.now() - lastActivity > idle * 1000) { return 'idle'; }
    return 'tracking';
}

function stateText(s: TrackState): string {
    switch (s) {
        case 'tracking': return `Takip ediliyor (${displayName(currentLanguage || '?')})`;
        case 'paused': return 'Duraklatıldı';
        case 'idle': return 'Boşta (hareketsiz)';
        case 'unfocused': return 'Pencere odakta değil';
        case 'ignored': return `Yok sayılan dil (${currentLanguage})`;
        default: return 'Aktif editör yok';
    }
}

function addTime(lang: string, sec: number) {
    const d = dateKey();
    const day = pending[d] || (pending[d] = {});
    day[lang] = (day[lang] || 0) + sec;
    dirty = true;
}

function tick() {
    const now = Date.now();
    let delta = (now - lastTick) / 1000;
    lastTick = now;
    if (delta <= 0 || delta > 10) { delta = 0; }

    if (computeState() === 'tracking' && currentLanguage && delta > 0) {
        addTime(currentLanguage, delta);
    }

    tickCount++;
    if (tickCount % 10 === 0) { updateStatusBar(); }
}

function restartTimers() {
    [tickTimer, saveTimer, syncTimer].forEach(t => t && clearInterval(t));
    lastTick = Date.now();

    tickTimer = setInterval(tick, 1000);

    const saveSec = Math.max(10, getSetting<number>('autoSaveIntervalSeconds', 60));
    saveTimer = setInterval(() => { saveStats(); }, saveSec * 1000);

    syncTimer = undefined;
    if (getSetting<boolean>('discord.autoSync', true)) {
        const syncSec = Math.max(60, getSetting<number>('discord.syncIntervalSeconds', 120));
        syncTimer = setInterval(() => {
            if (dirty) { void syncDiscord(false); }
        }, syncSec * 1000);
    }
}

function createStatusBar() {
    statusBarItem?.dispose();
    statusBarItem = undefined;
    if (!getSetting<boolean>('statusBar.enabled', true)) { return; }

    const align = getSetting<string>('statusBar.alignment', 'right') === 'left'
        ? vscode.StatusBarAlignment.Left
        : vscode.StatusBarAlignment.Right;

    statusBarItem = vscode.window.createStatusBarItem(align, getSetting<number>('statusBar.priority', 100));
    statusBarItem.command = 'codetime.openMenu';
    statusBarItem.show();
    updateStatusBar();
}

function updateStatusBar() {
    if (!statusBarItem) { return; }

    const state = computeState();
    const icon = state === 'paused' ? '$(debug-pause)' : state === 'idle' ? '$(watch)' : '$(clock)';
    const today = sumValues(getRange(1));

    statusBarItem.text = getSetting<boolean>('statusBar.showToday', true)
        ? `${icon} ${uiFmt(today)}`
        : `${icon} CodeTime`;

    const maxLangs = Math.max(1, getSetting<number>('display.tooltipMaxLanguages', 4));
    const sorted = aggregate(getRange(0));
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    const lines: string[] = [
        '**CodeTime**',
        `Durum: ${stateText(state)}`,
        `Bugün: **${uiFmt(today)}**  •  Toplam: **${uiFmt(sumValues(getRange(0)))}**`,
        '---'
    ];
    sorted.slice(0, maxLangs).forEach(([l, s], i) => lines.push(`${i + 1}. ${l}: ${uiFmt(s)}`));
    if (sorted.length > maxLangs) {
        lines.push(`Diğer: ${uiFmt(sorted.slice(maxLangs).reduce((a, b) => a + b[1], 0))}`);
    }
    lines.push('---');
    lines.push(`Son Discord senkronu: ${lastSync ? lastSync.toLocaleTimeString() : 'henüz yok'}`);
    lines.push('[Menü](command:codetime.openMenu) • [İstatistikler](command:codetime.showStats) • [Duraklat](command:codetime.togglePause)');

    md.appendMarkdown(lines.join('\n\n'));
    statusBarItem.tooltip = md;
}

function buildPayload() {
    const range = getSetting<string>('discord.range', 'allTime');
    const days = range === 'today' ? 1 : range === 'last7Days' ? 7 : range === 'last30Days' ? 30 : 0;
    const fmt = getSetting<TimeFormat>('discord.timeFormat', 'hours');
    const sorted = aggregate(getRange(days));

    const lang = (i: number) => (sorted[i] ? sorted[i][0] : 'None');
    const time = (i: number) => (sorted[i] ? formatDuration(sorted[i][1], fmt) : formatDuration(0, fmt));

    const otherSeconds = sorted.slice(3).reduce((a, b) => a + b[1], 0);
    const lang4 = sorted.length > 3 ? 'Others' : 'None';
    const time4 = sorted.length > 3 ? formatDuration(otherSeconds, fmt) : formatDuration(0, fmt);

    const img = (i: number) => iconUrl(sorted[i] ? sorted[i][0] : undefined);
    const imgField = (name: string, url: string) => ({ type: 3, name, value: { url } });

    return {
        data: {
            dynamic: [
                { type: 1, name: 'lang1', value: lang(0) },
                { type: 1, name: 'time1', value: time(0) },
                { type: 1, name: 'lang2', value: lang(1) },
                { type: 1, name: 'time2', value: time(1) },
                { type: 1, name: 'lang3', value: lang(2) },
                { type: 1, name: 'time3', value: time(2) },
                { type: 1, name: 'lang4', value: lang4 },
                { type: 1, name: 'time4', value: time4 },
                imgField('img1', img(0)),
                imgField('img2', img(1)),
                imgField('img3', img(2)),
                imgField('img4', iconUrl(undefined))
            ]
        }
    };
}

function discordRequest(token: string, appId: string, userId: string, body: string):
    Promise<{ status: number; body: string; retryAfter?: number }> {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'discord.com',
            port: 443,
            path: `/api/v9/applications/${encodeURIComponent(appId)}/users/${encodeURIComponent(userId)}/identities/0/profile`,
            method: 'PATCH',
            headers: {
                'Authorization': `Bot ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'DiscordBot (https://github.com/discord/discord-api-docs, 1.0.0)',
                'Content-Length': Buffer.byteLength(body)
            }
        }, res => {
            let data = '';
            res.on('data', c => (data += c));
            res.on('end', () => resolve({
                status: res.statusCode ?? 0,
                body: data,
                retryAfter: Number(res.headers['retry-after']) || undefined
            }));
        });
        req.setTimeout(10000, () => req.destroy(new Error('Zaman aşımı')));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function syncDiscord(manual: boolean): Promise<boolean> {
    if (sending) { return false; }

    const appId = getSetting<string>('discord.applicationId', '').trim();
    const userId = getSetting<string>('discord.userId', '').trim();
    const token = await ctx.secrets.get(SECRET_KEY);

    if (!appId || !userId) {
        if (manual) {
            const a = await notify('warn', 'Application ID veya User ID ayarlanmamış.', 'Ayarları Aç');
            if (a) { void vscode.commands.executeCommand('codetime.openSettings'); }
        }
        return false;
    }
    if (!token) {
        if (manual) {
            const a = await notify('warn', 'Discord bot token ayarlanmamış.', 'Token Ayarla');
            if (a) { void vscode.commands.executeCommand('codetime.setBotToken'); }
        }
        return false;
    }

    sending = true;
    try {
        saveStats();
        const res = await discordRequest(token, appId, userId, JSON.stringify(buildPayload()));

        if (res.status >= 200 && res.status < 300) {
            dirty = false;
            lastSync = new Date();
            log('Discord verileri güncellendi.');
            updateStatusBar();
            if (manual) { void notify('info', 'Discord widget güncellendi.'); }
            return true;
        }

        let reason = `HTTP ${res.status}`;
        if (res.status === 401) { reason = 'Token geçersiz (401). Token\'ı yeniden ayarlayın.'; }
        else if (res.status === 403) { reason = 'Yetki yok (403).'; }
        else if (res.status === 404) { reason = 'Uygulama veya kullanıcı bulunamadı (404). ID\'leri kontrol edin.'; }
        else if (res.status === 429) { reason = `Rate limit (429). ${res.retryAfter ?? '?'} sn sonra tekrar deneyin.`; }
        log(`Discord hatası: ${reason} ${res.body}`);

        if (manual || Date.now() - lastErrorNotice > 30 * 60 * 1000) {
            lastErrorNotice = Date.now();
            void notify('error', `Discord güncellenemedi: ${reason}`);
        }
        return false;
    } catch (e) {
        log(`Discord istek hatası: ${errMsg(e)}`);
        if (manual || Date.now() - lastErrorNotice > 30 * 60 * 1000) {
            lastErrorNotice = Date.now();
            void notify('error', `Discord isteği başarısız: ${errMsg(e)}`);
        }
        return false;
    } finally {
        sending = false;
    }
}

// ───────────────────────── Komutlar ─────────────────────────

async function openMenu() {
    const today = sumValues(getRange(1));
    const total = sumValues(getRange(0));
    const tokenSet = !!(await ctx.secrets.get(SECRET_KEY));
    const autoSync = getSetting<boolean>('discord.autoSync', true);
    const state = computeState();
    const sep = (label: string): MenuItem => ({ label, kind: vscode.QuickPickItemKind.Separator });

    const items: MenuItem[] = [
        sep('Özet'),
        {
            label: `$(pulse) Bugün: ${uiFmt(today)}`,
            description: `Toplam: ${uiFmt(total)}`,
            detail: `${stateText(state)}  •  Son senkron: ${lastSync ? lastSync.toLocaleTimeString() : 'yok'}`,
            id: 'codetime.showStats'
        },

        sep('Veri'),
        { label: '$(cloud-upload) Kaydet ve Discord\'a Gönder', id: 'codetime.saveAndSync' },
        { label: '$(save) Sadece Kaydet', id: 'codetime.saveOnly' },
        { label: '$(sync) Discord\'a Son Verileri Gönder', id: 'codetime.syncDiscord' },

        sep('İstatistik'),
        { label: '$(graph) İstatistikleri Göster', description: 'Bugün / 7 gün / 30 gün / tüm zamanlar', id: 'codetime.showStats' },
        { label: '$(export) Dışa Aktar (JSON / CSV)', id: 'codetime.exportStats' },

        sep('Takip'),
        {
            label: paused ? '$(play) Takibi Devam Ettir' : '$(debug-pause) Takibi Duraklat',
            id: 'codetime.togglePause'
        },
        {
            label: '$(eye-closed) Mevcut Dili Takipten Çıkar',
            description: currentLanguage ?? 'aktif editör yok',
            id: 'codetime.ignoreCurrentLanguage'
        },
        {
            label: autoSync ? '$(circle-slash) Otomatik Discord Senkronunu Kapat' : '$(check) Otomatik Discord Senkronunu Aç',
            id: 'codetime.toggleAutoSync'
        },

        sep('Yönetim'),
        {
            label: '$(key) Discord Bot Token Ayarla',
            description: tokenSet ? 'ayarlı' : 'ayarlanmamış',
            id: 'codetime.setBotToken'
        },
        ...(tokenSet ? [{ label: '$(trash) Discord Bot Token Sil', id: 'codetime.clearBotToken' } as MenuItem] : []),
        { label: '$(discard) Bir Dilin Verisini Sıfırla', id: 'codetime.resetLanguage' },
        { label: '$(warning) Tüm İstatistikleri Sıfırla', id: 'codetime.resetStats' },
        { label: '$(file) İstatistik Dosyasını Aç', description: getStatsPath(), id: 'codetime.openStatsFile' },
        { label: '$(gear) Ayarları Aç', id: 'codetime.openSettings' }
    ];

    const pick = await vscode.window.showQuickPick(items, {
        title: 'CodeTime',
        placeHolder: 'Bir işlem seçin',
        matchOnDescription: true
    });
    if (pick?.id) { await vscode.commands.executeCommand(pick.id); }
}

async function showStats() {
    saveStats();

    const options: RangeItem[] = [
        { label: '$(calendar) Bugün', days: 1 },
        { label: '$(calendar) Son 7 Gün', days: 7 },
        { label: '$(calendar) Son 30 Gün', days: 30 },
        { label: '$(history) Tüm Zamanlar', days: 0 },
        { label: '$(list-ordered) Günlük Döküm', description: 'Son 14 gün', daily: true }
    ];
    const range = await vscode.window.showQuickPick(options, { title: 'CodeTime İstatistikleri', placeHolder: 'Aralık seçin' });
    if (!range) { return; }

    if (range.daily) {
        const merged = getDailyMerged();
        const rows = Array.from({ length: 14 }, (_, i) => {
            const key = dateKey(i);
            const m = merged[key] || {};
            return { key, total: sumValues(m), top: aggregate(m)[0] };
        });
        const max = Math.max(1, ...rows.map(r => r.total));
        const items: vscode.QuickPickItem[] = rows.map(r => ({
            label: r.key,
            description: uiFmt(r.total),
            detail: `${bar((r.total / max) * 100)}${r.top ? `   •   En çok: ${r.top[0]}` : ''}`
        }));
        await vscode.window.showQuickPick(items, { title: 'Günlük Döküm (son 14 gün)' });
        return;
    }

    const data = aggregate(getRange(range.days ?? 0));
    if (data.length === 0) {
        void notify('info', 'Bu aralıkta kayıt yok.');
        return;
    }
    const total = data.reduce((a, b) => a + b[1], 0);
    const items: vscode.QuickPickItem[] = data.map(([lang, sec]) => ({
        label: `$(symbol-keyword) ${lang}`,
        description: uiFmt(sec),
        detail: bar((sec / total) * 100)
    }));
    await vscode.window.showQuickPick(items, {
        title: `${range.label.replace(/\$\([^)]+\)\s*/, '')} — Toplam: ${uiFmt(total)}`
    });
}

function togglePause() {
    paused = !paused;
    lastTick = Date.now();
    markActivity();
    updateStatusBar();
    void notify('info', paused ? 'Takip duraklatıldı.' : 'Takip devam ediyor.');
}

async function toggleAutoSync() {
    const next = !getSetting<boolean>('discord.autoSync', true);
    await cfg().update('discord.autoSync', next, vscode.ConfigurationTarget.Global);
    void notify('info', `Otomatik Discord senkronu ${next ? 'açıldı' : 'kapatıldı'}.`);
}

async function ignoreCurrentLanguage() {
    if (!currentLanguage) {
        void notify('warn', 'Aktif bir editör yok.');
        return;
    }
    const list = getSetting<string[]>('ignoredLanguages', []);
    if (list.includes(currentLanguage)) {
        void notify('info', `"${currentLanguage}" zaten yok sayılıyor.`);
        return;
    }
    await cfg().update('ignoredLanguages', [...list, currentLanguage], vscode.ConfigurationTarget.Global);
    void notify('info', `"${currentLanguage}" artık takip edilmeyecek.`);
}

function toCsv(s: StatsFile): string {
    const rows = ['date,language,seconds'];
    for (const d of Object.keys(s.daily).sort()) {
        for (const [l, sec] of Object.entries(s.daily[d])) { rows.push(`${d},${l},${Math.round(sec)}`); }
    }
    for (const [l, sec] of Object.entries(s.languages)) { rows.push(`total,${l},${Math.round(sec)}`); }
    return rows.join('\n');
}

async function exportStats() {
    saveStats();
    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'codetime-export.json')),
        filters: { 'JSON': ['json'], 'CSV': ['csv'] },
        title: 'İstatistikleri Dışa Aktar'
    });
    if (!uri) { return; }
    try {
        const isCsv = path.extname(uri.fsPath).toLowerCase() === '.csv';
        fs.writeFileSync(uri.fsPath, isCsv ? toCsv(stats) : JSON.stringify(stats, null, 2), 'utf-8');
        void notify('info', `Dışa aktarıldı: ${uri.fsPath}`);
    } catch (e) {
        void notify('error', `Dışa aktarma başarısız: ${errMsg(e)}`);
    }
}

async function resetLanguage() {
    saveStats();
    const entries = Object.entries(getRange(0)).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
        void notify('info', 'Sıfırlanacak veri yok.');
        return;
    }
    const pick = await vscode.window.showQuickPick(
        entries.map(([l, s]) => ({ label: l, description: uiFmt(s) })),
        { title: 'Hangi dilin verisi sıfırlansın?' }
    );
    if (!pick) { return; }

    const ok = await vscode.window.showWarningMessage(
        `"${pick.label}" diline ait tüm veriler silinecek. Emin misiniz?`,
        { modal: true }, 'Evet, sıfırla'
    );
    if (!ok) { return; }

    const done = mutateStats(s => {
        delete s.languages[pick.label];
        for (const d of Object.keys(s.daily)) { delete s.daily[d][pick.label]; }
    });
    updateStatusBar();
    if (done) { void notify('info', `"${pick.label}" verisi sıfırlandı.`); }
}

async function resetStats() {
    const ok = await vscode.window.showWarningMessage(
        'Tüm CodeTime istatistikleri kalıcı olarak silinecek. Emin misiniz?',
        { modal: true }, 'Evet, sıfırla'
    );
    if (!ok) { return; }
    pending = {};
    try {
        const empty = emptyStats();
        writeStatsFile(empty);
        stats = empty;
        dirty = true;
        updateStatusBar();
        void notify('info', 'Tüm istatistikler sıfırlandı.');
    } catch (e) {
        void notify('error', `Sıfırlama başarısız: ${errMsg(e)}`);
    }
}

async function openStatsFile() {
    saveStats();
    const p = getStatsPath();
    if (!fs.existsSync(p)) { writeStatsFile(stats); }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
    await vscode.window.showTextDocument(doc);
}

async function setBotToken() {
    const token = await vscode.window.showInputBox({
        title: 'Discord Bot Token',
        prompt: 'Token güvenli depoda (SecretStorage) saklanır; ayar dosyalarına yazılmaz.',
        password: true,
        ignoreFocusOut: true,
        validateInput: v => (v.trim().length < 20 ? 'Geçerli bir token girin.' : undefined)
    });
    if (!token) { return; }
    await ctx.secrets.store(SECRET_KEY, token.trim());
    void notify('info', 'Bot token kaydedildi.');
}

async function clearBotToken() {
    await ctx.secrets.delete(SECRET_KEY);
    void notify('info', 'Bot token silindi.');
}

export function activate(context: vscode.ExtensionContext) {
    ctx = context;
    output = vscode.window.createOutputChannel('CodeTime');
    context.subscriptions.push(output);
    log('CodeTime Discord Tracker aktif.');

    try {
        stats = readStatsFile();
    } catch (e) {
        log(`İstatistik dosyası okunamadı: ${errMsg(e)}`);
        void notify('error', `İstatistik dosyası okunamadı, veriler korunuyor: ${errMsg(e)}`);
    }

    createStatusBar();
    context.subscriptions.push({ dispose: () => statusBarItem?.dispose() });

    const onEditorChange = (editor: vscode.TextEditor | undefined) => {
        currentLanguage = editor && isTrackable(editor.document) ? editor.document.languageId : undefined;
        markActivity();
        updateStatusBar();
    };
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(onEditorChange),
        vscode.window.onDidChangeTextEditorSelection(markActivity),
        vscode.window.onDidChangeTextEditorVisibleRanges(markActivity),
        vscode.workspace.onDidChangeTextDocument(markActivity),
        vscode.window.onDidChangeWindowState(s => {
            windowFocused = s.focused;
            if (s.focused) { markActivity(); lastTick = Date.now(); }
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('codetime')) {
                createStatusBar();
                restartTimers();
            }
        })
    );

    const reg = (id: string, fn: () => unknown) =>
        context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    reg('codetime.openMenu', openMenu);
    reg('codetime.saveAndSync', async () => {
        if (saveStats()) { void notify('info', 'Veriler kaydedildi.'); }
        await syncDiscord(true);
    });
    reg('codetime.saveOnly', () => {
        if (saveStats()) { void notify('info', `Veriler kaydedildi: ${getStatsPath()}`); }
    });
    reg('codetime.syncDiscord', () => syncDiscord(true));
    reg('codetime.showStats', showStats);
    reg('codetime.togglePause', togglePause);
    reg('codetime.toggleAutoSync', toggleAutoSync);
    reg('codetime.ignoreCurrentLanguage', ignoreCurrentLanguage);
    reg('codetime.exportStats', exportStats);
    reg('codetime.resetLanguage', resetLanguage);
    reg('codetime.resetStats', resetStats);
    reg('codetime.openStatsFile', openStatsFile);
    reg('codetime.setBotToken', setBotToken);
    reg('codetime.clearBotToken', clearBotToken);
    reg('codetime.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:YigitCahit.codetime-discord-tracker'));

    const active = vscode.window.activeTextEditor;
    if (active) { onEditorChange(active); }
    windowFocused = vscode.window.state.focused;
    restartTimers();
}

export function deactivate() {
    [tickTimer, saveTimer, syncTimer].forEach(t => t && clearInterval(t));
    saveStats();
}
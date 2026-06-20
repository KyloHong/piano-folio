'use strict';

require('dotenv').config();

const serverless = require('serverless-http');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');

// --------------------- Env Validation ---------------------

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = '7d';

// --------------------- Rate Limiting ---------------------

const loginAttempts = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

function checkRateLimit(key) {
    const now = Date.now();
    const record = loginAttempts.get(key);
    if (!record || now > record.resetAt) {
        loginAttempts.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
        return true;
    }
    if (record.count >= RATE_LIMIT_MAX) return false;
    record.count++;
    return true;
}

// --------------------- Turso HTTP API Client ---------------------

function getTursoEndpoint() {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) throw new Error('TURSO_DATABASE_URL 未设置');
    // libsql://db-url.turso.io -> https://db-url.turso.io/v2/pipeline
    const httpUrl = url.startsWith('libsql://')
        ? 'https://' + url.substring(9) + '/v2/pipeline'
        : url + '/v2/pipeline';
    return httpUrl;
}

function getTursoToken() {
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!token) throw new Error('TURSO_AUTH_TOKEN 未设置');
    return token;
}

// 将 JS 值转换为 Turso 支持的格式
function toTursoValue(val) {
    if (val === null || val === undefined) return { type: 'null' };
    if (typeof val === 'number') return { type: 'integer', value: val.toString() };
    if (typeof val === 'string') return { type: 'text', value: val };
    if (typeof val === 'boolean') return { type: 'integer', value: val ? '1' : '0' };
    return { type: 'text', value: String(val) };
}

// 解析 Turso HTTP API 返回的行数据
// Turso 返回格式可能是：
// {results: [{type: "ok", result: {cols: [...], rows: [[{type,value}]], affected_row_count, last_insert_rowid}}]}
// 或者：{results: [{cols: [...], rows: [[{type,value}]], affected_row_count, last_insert_rowid}]}
function parseTursoResult(response) {
    if (!response) return [];
    // 处理嵌套的 result 字段
    const data = response.result || response;
    if (!data.rows || data.rows.length === 0) return [];
    const cols = data.cols || [];
    return data.rows.map(row => {
        const obj = {};
        for (let i = 0; i < cols.length; i++) {
            const cell = row[i];
            const colName = cols[i].name || cols[i] || '';
            if (cell === null || cell === undefined) {
                obj[colName] = null;
            } else if (typeof cell === 'object' && cell !== null) {
                // 格式：{type: "integer", value: "1"}
                if (cell.type === 'null' || cell.value === null || cell.value === undefined) {
                    obj[colName] = null;
                } else if (cell.type === 'integer') {
                    obj[colName] = parseInt(cell.value, 10);
                } else if (cell.type === 'real') {
                    obj[colName] = parseFloat(cell.value);
                } else if (cell.type === 'blob') {
                    obj[colName] = cell.value;
                } else {
                    obj[colName] = cell.value;
                }
            } else {
                // 简单格式：直接是值
                obj[colName] = cell;
            }
        }
        return obj;
    });
}

function getAffectedCount(response) {
    if (!response) return 0;
    const data = response.result || response;
    return data.affected_row_count || data.rows_affected || 0;
}

function getLastInsertId(response) {
    if (!response) return null;
    // 处理可能的嵌套结构
    const data = response.result || response;
    // Turso 返回格式：{last_insert_rowid: {type: "integer", value: "123"}}
    // 或者直接：{last_insert_rowid: 123}
    let id = data.last_insert_rowid;
    if (id === null || id === undefined) return null;
    // 如果是对象格式 {type: "integer", value: "123"}
    if (typeof id === 'object' && id.value) {
        return parseInt(id.value, 10);
    }
    return parseInt(id, 10);
}

async function tursoExecute(sql, args = []) {
    const endpoint = getTursoEndpoint();
    const token = getTursoToken();

    const body = {
        requests: [{
            type: 'execute',
            stmt: {
                sql: sql,
                args: args.map(toTursoValue)
            }
        }]
    };

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify(body)
    });

    const text = await res.text();
    
    if (!res.ok) {
        console.error('Turso API error - status:', res.status, 'body:', text);
        throw new Error('Turso API error: ' + res.status + ' ' + text);
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        console.error('Turso response parse error:', text);
        throw new Error('Turso response parse error: ' + text);
    }
    
    // 处理 pipeline 格式
    const first = data.results ? data.results[0] : data;
    console.log('Turso FULL response:', JSON.stringify(data).substring(0, 500));
    console.log('Turso FIRST result:', JSON.stringify(first).substring(0, 300));
    if (first && first.error) {
        throw new Error(first.error.message || 'Turso query error');
    }
    return first;
}

async function dbAll(sql, args = []) {
    const result = await tursoExecute(sql, args);
    return parseTursoResult(result);
}

async function dbGet(sql, args = []) {
    const rows = await dbAll(sql, args);
    return rows[0] || null;
}

async function dbRun(sql, args = []) {
    const result = await tursoExecute(sql, args);
    return {
        changes: getAffectedCount(result),
        lastInsertRowid: getLastInsertId(result)
    };
}

// --------------------- Schema Init ---------------------

let schemaInited = false;
async function initSchema() {
    if (schemaInited) return;
    try {
        await tursoExecute(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await tursoExecute(`CREATE TABLE IF NOT EXISTS charts (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            song_title TEXT DEFAULT '',
            song_artist TEXT DEFAULT '',
            song_lyrics TEXT DEFAULT '[]',
            song_sections TEXT DEFAULT '{}',
            chord_data TEXT DEFAULT '{}',
            display_mode TEXT DEFAULT 'name',
            is_public INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        const addCol = async (table, col, def) => {
            try { await tursoExecute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (_) {}
        };
        await addCol('charts', 'is_public', 'INTEGER DEFAULT 0');
        await addCol('charts', 'song_lyrics', `TEXT DEFAULT '[]'`);
        await addCol('charts', 'song_sections', `TEXT DEFAULT '{}'`);
        await addCol('charts', 'display_mode', `TEXT DEFAULT 'name'`);
        schemaInited = true;
    } catch (e) {
        console.error('Schema init error:', e.message);
    }
}

// --------------------- Express App ---------------------

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --------------------- Helpers ---------------------

function toIsoUtc(ts) {
    if (!ts) return null;
    const s = String(ts).trim();
    if (s.endsWith('Z')) return s;
    if (s.includes('T')) return s + 'Z';
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
        return s.replace(' ', 'T') + 'Z';
    }
    return ts;
}

function convertChartTimestamps(chart) {
    if (!chart) return chart;
    if (chart.created_at) chart.created_at = toIsoUtc(chart.created_at);
    if (chart.updated_at) chart.updated_at = toIsoUtc(chart.updated_at);
    return chart;
}

// --------------------- Auth Middleware ---------------------

function authenticate(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: '未登录或登录已过期' });
    }
    const token = header.slice(7);
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.userId = payload.userId;
        req.username = payload.username;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Token 无效或已过期' });
    }
}

// --------------------- Auth API ---------------------

app.post('/api/auth/register', async (req, res) => {
    try {
        await initSchema();
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
        if (username.length < 2 || username.length > 30) return res.status(400).json({ error: '用户名长度需在 2-30 个字符之间' });
        if (password.length < 6 || password.length > 50) return res.status(400).json({ error: '密码长度需在 6-50 个字符之间' });
        if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) {
            return res.status(400).json({ error: '用户名只能包含字母、数字、下划线和中文' });
        }

        const existing = await dbGet('SELECT id FROM users WHERE username = ?', [username]);
        if (existing) return res.status(409).json({ error: '用户名已被占用' });

        const hash = bcrypt.hashSync(password, 10);
        const insertResult = await dbRun('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash]);
        console.log('Insert result:', JSON.stringify(insertResult));
        
        // 插入后通过用户名查询获取用户 ID（Turso HTTP API 是无状态的）
        const userQuery = await dbGet('SELECT id FROM users WHERE username = ?', [username]);
        console.log('User query result:', JSON.stringify(userQuery));
        const newUserId = userQuery ? userQuery.id : null;
        
        if (!newUserId) {
            console.error('Failed to get user ID after insert for:', username);
            return res.status(500).json({ error: '创建用户失败' });
        }
        
        const token = jwt.sign({ userId: newUserId, username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
        res.json({ token, userId: newUserId, username });
    } catch (e) {
        console.error('Register error:', e.message);
        if (e.message.includes('UNIQUE constraint') || e.message.includes('unique')) {
            return res.status(409).json({ error: '用户名已被占用' });
        }
        res.status(500).json({ error: '服务器错误，请稍后重试' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        await initSchema();
        const clientIp = req.ip || req.connection.remoteAddress;
        if (!checkRateLimit(clientIp)) {
            return res.status(429).json({ error: '登录尝试过于频繁，请15分钟后再试' });
        }
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });

        const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) return res.status(401).json({ error: '用户名或密码错误' });
        if (!bcrypt.compareSync(password, user.password_hash)) {
            return res.status(401).json({ error: '用户名或密码错误' });
        }
        const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
        res.json({ token, userId: user.id, username: user.username });
    } catch (e) {
        console.error('Login error:', e.message);
        res.status(500).json({ error: '服务器错误，请稍后重试' });
    }
});

app.get('/api/auth/me', authenticate, (req, res) => {
    res.json({ userId: req.userId, username: req.username });
});

// --------------------- My Charts API ---------------------

app.get('/api/charts/my', authenticate, async (req, res) => {
    try {
        await initSchema();
        const charts = (await dbAll(`SELECT id, name, song_title, song_artist, display_mode, is_public, created_at, updated_at FROM charts WHERE user_id = ? ORDER BY updated_at DESC`, [req.userId])).map(convertChartTimestamps);
        res.json(charts);
    } catch (e) {
        console.error('List charts error:', e.message);
        res.status(500).json({ error: '获取图谱列表失败' });
    }
});

app.get('/api/charts/my/:id', authenticate, async (req, res) => {
    try {
        await initSchema();
        const chart = await dbGet('SELECT * FROM charts WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
        if (!chart) return res.status(404).json({ error: '图谱不存在或无权访问' });
        res.json(convertChartTimestamps(chart));
    } catch (e) {
        console.error('Get chart error:', e.message);
        res.status(500).json({ error: '获取图谱详情失败' });
    }
});

app.post('/api/charts/my', authenticate, async (req, res) => {
    try {
        await initSchema();
        const { name, song, chord_data, display_mode } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: '图谱名称不能为空' });
        
        // 生成 UUID，兼容不支持 crypto.randomUUID 的环境
        const id = crypto.randomUUID ? crypto.randomUUID() : 
            'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                const r = Math.random() * 16 | 0;
                return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
            });
        
        const songData = song || {};
        const lyrics = Array.isArray(songData.lyrics) ? songData.lyrics : [];
        const sections = songData.sections || {};
        
        const result = await dbRun(`INSERT INTO charts (id, user_id, name, song_title, song_artist, song_lyrics, song_sections, chord_data, display_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            id, req.userId, name.trim(),
            songData.title || '', songData.artist || '',
            JSON.stringify(lyrics), JSON.stringify(sections),
            JSON.stringify(chord_data || {}),
            display_mode || 'name'
        ]);
        
        console.log('Chart created:', id, 'changes:', result.changes);
        res.json({ id, message: '图谱创建成功' });
    } catch (e) {
        console.error('Create chart error:', e.message);
        res.status(500).json({ error: '创建图谱失败: ' + e.message });
    }
});

app.put('/api/charts/my/:id', authenticate, async (req, res) => {
    try {
        await initSchema();
        const { name, song, chord_data, display_mode, is_public } = req.body;
        const chart = await dbGet('SELECT * FROM charts WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
        if (!chart) return res.status(404).json({ error: '图谱不存在或无权修改' });
        const songData = song || {};
        const lyrics = Array.isArray(songData.lyrics) ? songData.lyrics : [];
        const sections = songData.sections || {};
        await dbRun(`UPDATE charts SET name = ?, song_title = ?, song_artist = ?, song_lyrics = ?, song_sections = ?, chord_data = ?, display_mode = ?, is_public = CASE WHEN ? IS NOT NULL THEN ? ELSE is_public END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`, [
            name ? name.trim() : chart.name,
            songData.title !== undefined ? songData.title : chart.song_title,
            songData.artist !== undefined ? songData.artist : chart.song_artist,
            JSON.stringify(lyrics),
            JSON.stringify(sections),
            JSON.stringify(chord_data !== undefined ? chord_data : (chart.chord_data ? JSON.parse(chart.chord_data) : {})),
            display_mode || chart.display_mode,
            is_public !== undefined ? (is_public ? 1 : 0) : null,
            is_public !== undefined ? (is_public ? 1 : 0) : null,
            req.params.id,
            req.userId
        ]);
        res.json({ message: '更新成功' });
    } catch (e) {
        console.error('Update chart error:', e.message);
        res.status(500).json({ error: '更新图谱失败' });
    }
});

app.delete('/api/charts/my/:id', authenticate, async (req, res) => {
    try {
        await initSchema();
        const result = await dbRun('DELETE FROM charts WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
        if (result.changes === 0) return res.status(404).json({ error: '图谱不存在或无权删除' });
        res.json({ message: '删除成功' });
    } catch (e) {
        console.error('Delete chart error:', e.message);
        res.status(500).json({ error: '删除图谱失败' });
    }
});

app.put('/api/charts/my/:id/public', authenticate, async (req, res) => {
    try {
        await initSchema();
        const { is_public } = req.body;
        const chart = await dbGet('SELECT id FROM charts WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
        if (!chart) return res.status(404).json({ error: '图谱不存在或无权操作' });
        await dbRun('UPDATE charts SET is_public = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [is_public ? 1 : 0, req.params.id, req.userId]);
        res.json({ message: is_public ? '已发布到公共图谱' : '已从公共图谱取消发布' });
    } catch (e) {
        console.error('Publish error:', e.message);
        res.status(500).json({ error: '操作失败' });
    }
});

// --------------------- Public Charts API ---------------------

app.get('/api/charts/public', async (req, res) => {
    try {
        await initSchema();
        const charts = (await dbAll(`SELECT c.id, c.name, c.song_title, c.song_artist, c.display_mode, c.created_at, c.updated_at, u.username as author FROM charts c JOIN users u ON c.user_id = u.id WHERE c.is_public = 1 ORDER BY c.updated_at DESC`)).map(convertChartTimestamps);
        res.json(charts);
    } catch (e) {
        console.error('List public charts error:', e.message);
        res.status(500).json({ error: '获取公共图谱失败' });
    }
});

app.get('/api/charts/public/:id', async (req, res) => {
    try {
        await initSchema();
        const chart = await dbGet(`SELECT c.*, u.username as author FROM charts c JOIN users u ON c.user_id = u.id WHERE c.id = ? AND c.is_public = 1`, [req.params.id]);
        if (!chart) return res.status(404).json({ error: '公共图谱不存在' });
        res.json(convertChartTimestamps(chart));
    } catch (e) {
        console.error('Get public chart error:', e.message);
        res.status(500).json({ error: '获取图谱详情失败' });
    }
});

// --------------------- Health Check (调试用) ---------------------
app.get('/api/health', async (req, res) => {
    try {
        const hasTursoUrl = !!process.env.TURSO_DATABASE_URL;
        const hasTursoToken = !!process.env.TURSO_AUTH_TOKEN;
        
        // 直接调用 Turso 并返回原始响应
        let rawSelect1 = null;
        let rawSelect2 = null;
        let rawInsert = null;
        
        try {
            rawSelect1 = await tursoExecute('SELECT 1 as test_col');
        } catch (e) {
            rawSelect1 = { error: e.message };
        }
        
        try {
            rawInsert = await tursoExecute('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
        } catch (e) {
            rawInsert = { error: e.message };
        }
        
        try {
            rawSelect2 = await tursoExecute('SELECT COUNT(*) as cnt FROM users');
        } catch (e) {
            rawSelect2 = { error: e.message };
        }
        
        res.json({
            turso_url_configured: hasTursoUrl,
            turso_token_configured: hasTursoToken,
            raw_select_1: rawSelect1,
            raw_insert: rawInsert,
            raw_select_2: rawSelect2,
            parsed_users: {
                all: await dbAll('SELECT * FROM users LIMIT 3'),
                get: await dbGet('SELECT * FROM users LIMIT 1')
            },
            server_time: new Date().toISOString()
        });
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

// --------------------- Handler ---------------------

// Netlify Function 收到的路径是 /.netlify/functions/api/charts/my
// 我们需要把它改成 /api/charts/my 才能匹配 Express 路由
const httpHandler = serverless(app);

module.exports.handler = (event, context) => {
    const fnPrefix = '/.netlify/functions/api';
    
    // 确保 event.path 存在，用于 serverless-http 路由
    const pathToUse = event.rawPath || event.path || '/';
    
    // 如果是函数路径，重写为 API 路径
    if (pathToUse.startsWith(fnPrefix)) {
        const newPath = '/api' + pathToUse.slice(fnPrefix.length);
        event.path = newPath;
        event.rawPath = newPath;
    }
    
    return httpHandler(event, context);
};
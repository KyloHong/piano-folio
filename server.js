'use strict';

require('dotenv').config();

const express = require('express');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

// --------------------- Env Validation ---------------------

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('❌ 错误：JWT_SECRET 环境变量未设置');
    console.error('   请在 .env 或 Vercel Environment Variables 中设置 JWT_SECRET=<随机字符串>');
    process.exit(1);
}
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

// --------------------- Turso DB Client ---------------------

// 模块级别，Vercel 会缓存实例
let tursoClient;
function getDb() {
    if (!tursoClient) {
        const url = process.env.TURSO_DATABASE_URL;
        const token = process.env.TURSO_AUTH_TOKEN;
        if (!url || !token) {
            throw new Error('TURSO_DATABASE_URL 和 TURSO_AUTH_TOKEN 未设置，请在 Vercel 环境变量中配置');
        }
        tursoClient = createClient({ url, authToken: token });
    }
    return tursoClient;
}

// 把 BigInt 转为普通数字（JSON 不支持 BigInt）
function normalise(obj) {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map(normalise);
    if (typeof obj === 'bigint') return Number(obj);
    if (typeof obj === 'object') {
        const out = {};
        for (const k of Object.keys(obj)) {
            out[k] = normalise(obj[k]);
        }
        return out;
    }
    return obj;
}

async function dbAll(sql, args = []) {
    const result = await getDb().execute({ sql, args });
    return normalise(result.rows);
}

async function dbGet(sql, args = []) {
    const rows = await dbAll(sql, args);
    return rows[0] || null;
}

async function dbRun(sql, args = []) {
    const result = await getDb().execute({ sql, args });
    return {
        changes: Number(result.rowsAffected || 0),
        lastInsertRowid: result.lastInsertRowid ? Number(result.lastInsertRowid) : null
    };
}

// 初始化表结构（首次请求时懒加载执行，避免冷启动等待过久）
let schemaInited = false;
async function initSchema() {
    if (schemaInited) return;
    try {
        await getDb().execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await getDb().execute(`
            CREATE TABLE IF NOT EXISTS charts (
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
            )
        `);
        // 尝试添加缺失的列（向后兼容）
        const addCol = async (table, col, def) => {
            try { await getDb().execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (_) {}
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
app.use(express.static(path.join(__dirname)));

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
        const result = await dbRun('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash]);
        const newUserId = result.lastInsertRowid;
        const token = jwt.sign({ userId: newUserId, username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
        res.json({ token, userId: newUserId, username });
    } catch (e) {
        console.error('Register error:', e);
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
        console.error('Login error:', e);
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
        const charts = (await dbAll(`
            SELECT id, name, song_title, song_artist, display_mode, is_public, created_at, updated_at
            FROM charts WHERE user_id = ? ORDER BY updated_at DESC
        `, [req.userId])).map(convertChartTimestamps);
        res.json(charts);
    } catch (e) {
        console.error('List charts error:', e);
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
        console.error('Get chart error:', e);
        res.status(500).json({ error: '获取图谱详情失败' });
    }
});

app.post('/api/charts/my', authenticate, async (req, res) => {
    try {
        await initSchema();
        const { name, song, chord_data, display_mode } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: '图谱名称不能为空' });
        const id = crypto.randomUUID();
        const songData = song || {};
        const lyrics = Array.isArray(songData.lyrics) ? songData.lyrics : [];
        const sections = songData.sections || {};
        await dbRun(`
            INSERT INTO charts (id, user_id, name, song_title, song_artist, song_lyrics, song_sections, chord_data, display_mode)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            id, req.userId, name.trim(),
            songData.title || '', songData.artist || '',
            JSON.stringify(lyrics), JSON.stringify(sections),
            JSON.stringify(chord_data || {}),
            display_mode || 'name'
        ]);
        res.json({ id, message: '图谱创建成功' });
    } catch (e) {
        console.error('Create chart error:', e);
        res.status(500).json({ error: '创建图谱失败' });
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
        await dbRun(`
            UPDATE charts SET
                name = ?, song_title = ?, song_artist = ?,
                song_lyrics = ?, song_sections = ?, chord_data = ?, display_mode = ?,
                is_public = CASE WHEN ? IS NOT NULL THEN ? ELSE is_public END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ?
        `, [
            name ? name.trim() : chart.name,
            songData.title || chart.song_title,
            songData.artist || chart.song_artist,
            JSON.stringify(lyrics),
            JSON.stringify(sections),
            JSON.stringify(chord_data || (chart.chord_data ? JSON.parse(chart.chord_data) : {})),
            display_mode || chart.display_mode,
            is_public !== undefined ? (is_public ? 1 : 0) : null,
            is_public !== undefined ? (is_public ? 1 : 0) : null,
            req.params.id,
            req.userId
        ]);
        res.json({ message: '更新成功' });
    } catch (e) {
        console.error('Update chart error:', e);
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
        console.error('Delete chart error:', e);
        res.status(500).json({ error: '删除图谱失败' });
    }
});

app.put('/api/charts/my/:id/public', authenticate, async (req, res) => {
    try {
        await initSchema();
        const { is_public } = req.body;
        const chart = await dbGet('SELECT * FROM charts WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
        if (!chart) return res.status(404).json({ error: '图谱不存在或无权操作' });
        await dbRun('UPDATE charts SET is_public = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
            [is_public ? 1 : 0, req.params.id, req.userId]);
        res.json({ message: is_public ? '已发布到公共图谱' : '已从公共图谱取消发布' });
    } catch (e) {
        console.error('Publish error:', e);
        res.status(500).json({ error: '操作失败' });
    }
});

// --------------------- Public Charts API ---------------------

app.get('/api/charts/public', async (req, res) => {
    try {
        await initSchema();
        const charts = (await dbAll(`
            SELECT c.id, c.name, c.song_title, c.song_artist, c.display_mode,
                   c.created_at, c.updated_at, u.username as author
            FROM charts c
            JOIN users u ON c.user_id = u.id
            WHERE c.is_public = 1
            ORDER BY c.updated_at DESC
        `)).map(convertChartTimestamps);
        res.json(charts);
    } catch (e) {
        console.error('List public charts error:', e);
        res.status(500).json({ error: '获取公共图谱失败' });
    }
});

app.get('/api/charts/public/:id', async (req, res) => {
    try {
        await initSchema();
        const chart = await dbGet(`
            SELECT c.*, u.username as author
            FROM charts c
            JOIN users u ON c.user_id = u.id
            WHERE c.id = ? AND c.is_public = 1
        `, [req.params.id]);
        if (!chart) return res.status(404).json({ error: '公共图谱不存在' });
        res.json(convertChartTimestamps(chart));
    } catch (e) {
        console.error('Get public chart error:', e);
        res.status(500).json({ error: '获取图谱详情失败' });
    }
});

// --------------------- Fallback for SPA ---------------------

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --------------------- Start (local only) ---------------------

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`\n  🎹 钢琴和弦图谱服务已启动\n  地址: http://localhost:${PORT}\n  数据库: Turso (${process.env.TURSO_DATABASE_URL || '(未配置)'})\n`);
    });
}

module.exports = app;

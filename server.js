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
// 只在直接运行时检查，Vercel Serverless 不在这里检查
if (!JWT_SECRET && require.main === module) {
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

// --------------------- Music Search API (NetEase Cloud Music) ---------------------

// 搜索歌曲（使用网易云官方 API）
app.get('/api/music/search', async (req, res) => {
    const { q } = req.query;
    if (!q || q.trim().length === 0) {
        return res.status(400).json({ error: '请输入搜索关键词' });
    }

    try {
        // 使用网易云音乐官方搜索 API
        const searchUrl = `https://music.163.com/api/search/get/?s=${encodeURIComponent(q.trim())}&type=1&limit=20`;
        const response = await fetch(searchUrl, {
            headers: {
                'Referer': 'https://music.163.com',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) {
            throw new Error(`搜索 API 返回 ${response.status}`);
        }

        const data = await response.json();
        if (data.code !== 200 || !data.result || !data.result.songs) {
            throw new Error('搜索结果格式错误');
        }

        // 网易云搜索 API 返回的 album 对象不含 picUrl，需要用歌曲详情 API 补获封面
        const songs = data.result.songs.map(item => ({
            id: item.id,
            name: item.name || '未知歌曲',
            artist: item.artists && item.artists.length > 0 ? item.artists.map(a => a.name).join('/') : '未知歌手',
            album: item.album ? item.album.name : '未知专辑',
            cover: null
        }));

        // 批量获取歌曲详情（含专辑封面 picUrl）
        try {
            const songIds = JSON.stringify(songs.map(s => s.id));
            const detailUrl = `https://music.163.com/api/song/detail/?ids=${encodeURIComponent(songIds)}`;
            const detailResp = await fetch(detailUrl, {
                headers: {
                    'Referer': 'https://music.163.com',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            if (detailResp.ok) {
                const detailData = await detailResp.json();
                if (detailData.code === 200 && detailData.songs) {
                    const coverMap = {};
                    detailData.songs.forEach(s => {
                        if (s.album && s.album.picUrl) {
                            coverMap[s.id] = s.album.picUrl.replace(/^http:/, 'https:');
                        }
                    });
                    songs.forEach(s => {
                        if (coverMap[s.id]) s.cover = coverMap[s.id];
                    });
                }
            }
        } catch (e) {
            // 封面获取失败不影响主流程
            console.error('封面获取失败:', e.message);
        }

        res.json({ songs });
    } catch (error) {
        console.error('音乐搜索错误:', error.message);
        res.status(500).json({ error: '搜索失败，请稍后重试' });
    }
});

// 获取歌词（使用网易云官方 API）
app.get('/api/music/lyric', async (req, res) => {
    const { id } = req.query;
    if (!id) {
        return res.status(400).json({ error: '缺少歌曲 ID' });
    }

    try {
        // 使用网易云音乐官方歌词 API
        const lyricUrl = `https://music.163.com/api/song/lyric?os=pc&id=${id}&lv=-1`;
        const response = await fetch(lyricUrl, {
            headers: {
                'Referer': 'https://music.163.com',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) {
            throw new Error(`歌词 API 返回 ${response.status}`);
        }

        const data = await response.json();
        if (data.code !== 200) {
            throw new Error('获取歌词失败');
        }

        // 网易云返回格式: { lrc: { lyric: "歌词文本" } }
        let lyricText = '';
        if (data.lrc && data.lrc.lyric) {
            lyricText = data.lrc.lyric;
        }

        // 过滤掉作词、作曲等元信息
        const lines = lyricText.split('\n');
        const filteredLines = lines.filter(line => {
            // 移除时间轴 [00:xx.xx]
            const timeMatch = line.match(/^\[\d{2}:\d{2}(.\d{2})?\]/);
            const content = timeMatch ? line.substring(line.indexOf(']') + 1).trim() : line.trim();

            // 如果只是时间轴，继续判断下一行
            if (!content) return false;

            // 过滤掉包含以下关键词的行（支持多种格式）
            const metaKeywords = ['作词', '作曲', '编曲', '制作', '监制', '制作人', '吉他', '贝斯', '鼓', '键盘', '和声', '混音', '录音', '版权', '发行', '演唱', '原唱'];
            for (const kw of metaKeywords) {
                // 支持多种分隔符格式
                if (content.includes(kw + '：') ||      // 中文冒号
                    content.includes(kw + ':') ||       // 英文冒号
                    content.includes(kw + '_:_') ||     // 下划线格式
                    content.includes(kw + '_') ||       // 关键词后直接跟下划线
                    content.includes(kw + ' _ ') ||     // 空格下划线空格
                    content.startsWith(kw)) {           // 以关键词开头的行
                    return false;
                }
            }

            // 过滤掉纯符号或空内容
            if (!content || /^[\s\d.。,，、；;：:\-\[\]]+$/.test(content)) {
                return false;
            }

            return true;
        });

        res.json({ lyric: filteredLines.join('\n') });
    } catch (error) {
        console.error('歌词获取错误:', error.message);
        res.status(500).json({ error: '获取歌词失败' });
    }
});

// --------------------- Chord Database API ---------------------

// 和弦数据库（空 - 使用 AI 分析生成和弦）
const chordDatabase = {};

// 搜索和弦
app.get('/api/chords/search', async (req, res) => {
    const { q } = req.query;
    if (!q || q.trim().length === 0) {
        return res.status(400).json({ error: '请输入歌曲名称' });
    }

    const query = q.trim().toLowerCase();
    const results = Object.keys(chordDatabase).filter(title => 
        title.toLowerCase().includes(query)
    ).map(title => ({
        title: chordDatabase[title].title,
        artist: chordDatabase[title].artist,
        key: chordDatabase[title].key,
        capo: chordDatabase[title].capo
    }));

    res.json({ songs: results });
});

// 获取歌曲和弦详情
app.get('/api/chords/detail', async (req, res) => {
    const { title } = req.query;
    if (!title) {
        return res.status(400).json({ error: '缺少歌曲名称' });
    }

    const song = chordDatabase[title.trim()];
    if (!song) {
        return res.status(404).json({ error: '未找到该歌曲的和弦信息' });
    }

    res.json(song);
});

// --------------------- AI 和弦分析接口 (智谱 AI) ---------------------

app.post('/api/chords/analyze', async (req, res) => {
    const { songName, artist, lyrics } = req.body;
    
    if (!songName) {
        return res.status(400).json({ error: '请提供歌曲名称' });
    }

    // 准备歌词文本（限制长度以加快响应）
    const lyricsText = Array.isArray(lyrics) ? lyrics.join('\n') : (lyrics || '');
    const truncatedLyrics = lyricsText.substring(0, 500); // 限制歌词长度

    try {
        // 简化 prompt 以加快 AI 响应
        const prompt = `分析歌曲和弦，返回JSON格式。

歌曲：${songName} - ${artist || '未知'}
歌词：${truncatedLyrics}

返回格式：
{"key":"C","sections":{"主歌":{"chords":["C","G","Am","F"]},"副歌":{"chords":["F","G","Em","Am"]}}}

只返回JSON，不要其他文字。`;

        // 调用智谱 AI API
        const zhipuApiKey = process.env.ZHIPU_API_KEY || '5fb97c25c3694b209d0ca5d45c591b17.rAvFbIZS3eLoWORz';
        
        // 设置 7 秒超时，确保在 Vercel 10 秒限制内完成
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);
        
        let response;
        try {
            console.log('开始调用智谱 AI API...');
            response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${zhipuApiKey}`
                },
                body: JSON.stringify({
                    model: 'glm-4-flash',
                    messages: [
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.3,  // 降低温度以加快响应
                    max_tokens: 500    // 大幅减少 token 数量
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            console.log('智谱 AI API 响应状态:', response.status);
        } catch (fetchError) {
            clearTimeout(timeoutId);
            console.error('智谱 AI API fetch 错误:', fetchError.name, fetchError.message);
            if (fetchError.name === 'AbortError') {
                throw new Error('AI API 请求超时（7秒）');
            }
            throw new Error(`AI API 连接失败: ${fetchError.message}`);
        }

        if (!response.ok) {
            const errorText = await response.text();
            console.error('智谱 AI API 错误:', errorText);
            throw new Error(`智谱 AI API 返回错误: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        console.log('智谱 AI 返回数据:', JSON.stringify(data, null, 2));
        
        const message = data.choices?.[0]?.message;
        // GLM-4-Flash 返回 content
        let aiContent = message?.content || message?.reasoning_content || '';

        if (!aiContent) {
            console.error('智谱 AI 返回内容为空:', JSON.stringify(data));
            throw new Error('智谱 AI 未返回有效内容');
        }

        // 提取 JSON 部分（可能包含在 markdown 代码块中）
        let jsonStr = aiContent.trim();
        const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1];
        }

        // 尝试解析 JSON
        let analysisResult;
        try {
            analysisResult = JSON.parse(jsonStr);
        } catch (parseError) {
            console.error('JSON 解析错误:', parseError);
            // 尝试修复常见的 JSON 问题
            jsonStr = jsonStr.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
            analysisResult = JSON.parse(jsonStr);
        }

        res.json({
            success: true,
            analysis: analysisResult
        });

    } catch (error) {
        console.error('AI 和弦分析错误:', error.message);
        
        // 备用方案：使用本地和弦数据库生成结果
        const fallbackResult = {
            key: 'C',
            tempo: '中等速度',
            sections: {
                '前奏': { duration: 4, chords: ['C', 'G', 'Am', 'F'] },
                '主歌': { lyrics: lyricsText.substring(0, 50), chords: ['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F'] },
                '副歌': { lyrics: lyricsText.substring(0, 50), chords: ['F', 'G', 'Em', 'Am', 'Dm', 'G', 'C', 'C7'] },
                '桥段': { chords: ['Am', 'Em', 'F', 'G'] },
                '尾奏': { chords: ['C', 'G', 'C'] }
            },
            beatPerMeasure: 4,
            chordDuration: '1beat'
        };
        
        console.log('使用备用和弦方案');
        res.json({
            success: true,
            analysis: fallbackResult,
            fallback: true,
            message: 'AI 服务暂时不可用，已使用默认和弦方案'
        });
    }
});

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

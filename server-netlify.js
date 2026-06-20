'use strict';

require('dotenv').config();

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');

// --------------------- Env Validation ---------------------

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const JWT_EXPIRES = '7d';

// --------------------- Supabase DB Client ---------------------

let supabase;
function getDb() {
    if (!supabase) {
        if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
            throw new Error('SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY 未设置，请在 Netlify 环境变量中配置');
        }
        supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    }
    return supabase;
}

// Supabase 查询辅助：.select().eq().single() 如果没有结果会返回 error
function singleOrNull(result) {
    if (result.error) {
        // PGGRST116 = no rows returned from single()
        if (result.error.code === 'PGGRST116' || result.error.details === 'The result contains 0 rows') {
            return null;
        }
        throw result.error;
    }
    return result.data;
}

// --------------------- Express App ---------------------

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --------------------- Helpers ---------------------

function toIsoUtc(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    return d.toISOString();
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
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
        if (username.length < 2 || username.length > 30) return res.status(400).json({ error: '用户名长度需在 2-30 个字符之间' });
        if (password.length < 6 || password.length > 50) return res.status(400).json({ error: '密码长度需在 6-50 个字符之间' });
        if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) {
            return res.status(400).json({ error: '用户名只能包含字母、数字、下划线和中文' });
        }

        // 检查用户名是否已被占用
        const { data: existing } = await getDb()
            .from('users')
            .select('id')
            .eq('username', username);

        if (existing && existing.length > 0) return res.status(409).json({ error: '用户名已被占用' });

        // 创建用户
        const hash = bcrypt.hashSync(password, 10);
        const { data: newUsers, error: insertErr } = await getDb()
            .from('users')
            .insert({ username, password_hash: hash })
            .select('id');

        if (insertErr) {
            // 23505 = 唯一约束冲突
            if (insertErr.code === '23505') return res.status(409).json({ error: '用户名已被占用' });
            throw insertErr;
        }

        const newUserId = newUsers[0].id;
        const token = jwt.sign({ userId: newUserId, username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
        res.json({ token, userId: newUserId, username });
    } catch (e) {
        console.error('Register error:', e.message);
        res.status(500).json({ error: '服务器错误，请稍后重试' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });

        const { data: users } = await getDb()
            .from('users')
            .select('id, username, password_hash')
            .eq('username', username);

        if (!users || users.length === 0) return res.status(401).json({ error: '用户名或密码错误' });

        const user = users[0];
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
        const { data: charts } = await getDb()
            .from('charts')
            .select('id, name, song_title, song_artist, display_mode, is_public, created_at, updated_at')
            .eq('user_id', req.userId)
            .order('updated_at', { ascending: false });

        res.json((charts || []).map(convertChartTimestamps));
    } catch (e) {
        console.error('List charts error:', e.message);
        res.status(500).json({ error: '获取图谱列表失败' });
    }
});

app.get('/api/charts/my/:id', authenticate, async (req, res) => {
    try {
        const { data: charts } = await getDb()
            .from('charts')
            .select('*')
            .eq('id', req.params.id)
            .eq('user_id', req.userId);

        if (!charts || charts.length === 0) return res.status(404).json({ error: '图谱不存在或无权访问' });
        res.json(convertChartTimestamps(charts[0]));
    } catch (e) {
        console.error('Get chart error:', e.message);
        res.status(500).json({ error: '获取图谱详情失败' });
    }
});

app.post('/api/charts/my', authenticate, async (req, res) => {
    try {
        const { name, song, chord_data, display_mode } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: '图谱名称不能为空' });
        const id = crypto.randomUUID();
        const songData = song || {};
        const lyrics = Array.isArray(songData.lyrics) ? songData.lyrics : [];
        const sections = songData.sections || {};

        const { error } = await getDb()
            .from('charts')
            .insert({
                id,
                user_id: req.userId,
                name: name.trim(),
                song_title: songData.title || '',
                song_artist: songData.artist || '',
                song_lyrics: lyrics,
                song_sections: sections,
                chord_data: chord_data || {},
                display_mode: display_mode || 'name'
            });

        if (error) throw error;
        res.json({ id, message: '图谱创建成功' });
    } catch (e) {
        console.error('Create chart error:', e.message);
        res.status(500).json({ error: '创建图谱失败' });
    }
});

app.put('/api/charts/my/:id', authenticate, async (req, res) => {
    try {
        const { name, song, chord_data, display_mode, is_public } = req.body;

        const { data: existing } = await getDb()
            .from('charts')
            .select('*')
            .eq('id', req.params.id)
            .eq('user_id', req.userId);

        if (!existing || existing.length === 0) return res.status(404).json({ error: '图谱不存在或无权修改' });

        const chart = existing[0];
        const songData = song || {};
        const lyrics = Array.isArray(songData.lyrics) ? songData.lyrics : [];
        const sections = songData.sections || {};

        const updates = {
            name: name ? name.trim() : chart.name,
            song_title: songData.title !== undefined ? songData.title : chart.song_title,
            song_artist: songData.artist !== undefined ? songData.artist : chart.song_artist,
            song_lyrics: lyrics,
            song_sections: sections,
            chord_data: chord_data !== undefined ? chord_data : chart.chord_data,
            display_mode: display_mode || chart.display_mode,
        };

        if (is_public !== undefined) {
            updates.is_public = is_public ? 1 : 0;
        }

        const { error } = await getDb()
            .from('charts')
            .update(updates)
            .eq('id', req.params.id)
            .eq('user_id', req.userId);

        if (error) throw error;
        res.json({ message: '更新成功' });
    } catch (e) {
        console.error('Update chart error:', e.message);
        res.status(500).json({ error: '更新图谱失败' });
    }
});

app.delete('/api/charts/my/:id', authenticate, async (req, res) => {
    try {
        const { error, status } = await getDb()
            .from('charts')
            .delete()
            .eq('id', req.params.id)
            .eq('user_id', req.userId);

        if (error) throw error;
        if (status === 404) return res.status(404).json({ error: '图谱不存在或无权删除' });
        res.json({ message: '删除成功' });
    } catch (e) {
        console.error('Delete chart error:', e.message);
        res.status(500).json({ error: '删除图谱失败' });
    }
});

app.put('/api/charts/my/:id/public', authenticate, async (req, res) => {
    try {
        const { is_public } = req.body;

        const { data: existing } = await getDb()
            .from('charts')
            .select('id')
            .eq('id', req.params.id)
            .eq('user_id', req.userId);

        if (!existing || existing.length === 0) return res.status(404).json({ error: '图谱不存在或无权操作' });

        const { error } = await getDb()
            .from('charts')
            .update({ is_public: is_public ? 1 : 0 })
            .eq('id', req.params.id)
            .eq('user_id', req.userId);

        if (error) throw error;
        res.json({ message: is_public ? '已发布到公共图谱' : '已从公共图谱取消发布' });
    } catch (e) {
        console.error('Publish error:', e.message);
        res.status(500).json({ error: '操作失败' });
    }
});

// --------------------- Public Charts API ---------------------

app.get('/api/charts/public', async (req, res) => {
    try {
        // 先取所有公共图谱
        const { data: rawCharts } = await getDb()
            .from('charts')
            .select('id, name, song_title, song_artist, display_mode, is_public, user_id, created_at, updated_at')
            .eq('is_public', 1)
            .order('updated_at', { ascending: false });

        if (!rawCharts || rawCharts.length === 0) {
            res.json([]);
            return;
        }

        // 批量获取作者用户名
        const userIds = [...new Set(rawCharts.map(c => c.user_id))];
        const { data: users } = await getDb().from('users').select('id, username').in('id', userIds);
        const userMap = new Map((users || []).map(u => [u.id, u.username]));

        const result = rawCharts.map(c => ({
            id: c.id,
            name: c.name,
            song_title: c.song_title,
            song_artist: c.song_artist,
            display_mode: c.display_mode,
            is_public: c.is_public,
            author: userMap.get(c.user_id) || 'unknown',
            created_at: toIsoUtc(c.created_at),
            updated_at: toIsoUtc(c.updated_at)
        }));
        res.json(result);
    } catch (e) {
        console.error('List public charts error:', e.message);
        res.status(500).json({ error: '获取公共图谱失败' });
    }
});

app.get('/api/charts/public/:id', async (req, res) => {
    try {
        const { data: charts } = await getDb()
            .from('charts')
            .select('*')
            .eq('id', req.params.id)
            .eq('is_public', 1);

        if (!charts || charts.length === 0) return res.status(404).json({ error: '公共图谱不存在' });

        const chart = charts[0];
        const { data: users } = await getDb()
            .from('users')
            .select('username')
            .eq('id', chart.user_id);

        res.json(convertChartTimestamps({
            ...chart,
            author: users && users[0] ? users[0].username : 'unknown'
        }));
    } catch (e) {
        console.error('Get public chart error:', e.message);
        res.status(500).json({ error: '获取图谱详情失败' });
    }
});

// --------------------- Start (local only) ---------------------

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`\n  🎹 钢琴和弦图谱服务已启动\n  地址: http://localhost:${PORT}\n  数据库: Supabase (${SUPABASE_URL || '(未配置)'})\n`);
    });
}

module.exports = app;
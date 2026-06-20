-- Supabase 数据库初始化脚本
-- 在 Supabase Dashboard -> SQL Editor 中执行此脚本

-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 图谱表
CREATE TABLE IF NOT EXISTS charts (
    id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    song_title TEXT DEFAULT '',
    song_artist TEXT DEFAULT '',
    song_lyrics JSONB DEFAULT '[]'::jsonb,
    song_sections JSONB DEFAULT '{}'::jsonb,
    chord_data JSONB DEFAULT '{}'::jsonb,
    display_mode TEXT DEFAULT 'name',
    is_public INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 用户名唯一索引
CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users(username);

-- 用户 ID 索引（加速查询）
CREATE INDEX IF NOT EXISTS charts_user_id_idx ON charts(user_id);

-- 公共图谱索引
CREATE INDEX IF NOT EXISTS charts_is_public_idx ON charts(is_public);

-- 更新时间自动更新触发器
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER charts_updated_at
    BEFORE UPDATE ON charts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
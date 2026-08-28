#!/usr/bin/env python3
"""带 Mock API 的静态文件服务器 - Piano Folio 预览（正确数据格式 + 预置数据）"""
import json
import uuid
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse
import os

os.chdir('/home/user/.super_doubao/super-doubao-runtime/workspace/piano-folio')

# ===== 工具函数 =====
def make_token():
    return 'mock_' + uuid.uuid4().hex[:32]

def make_chart_id():
    return 'chart_' + uuid.uuid4().hex[:12]

def make_public_id():
    return 'pub_' + uuid.uuid4().hex[:10]

def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ')

# ===== 预置测试图谱数据 =====
def make_sample_charts():
    """创建3首预置测试图谱，使用前端期望的字段格式"""
    charts = []

    # 1. 小星星
    lyrics1 = [
        "一闪一闪亮晶晶",
        "满天都是小星星",
        "挂在天上放光明",
        "好像许多小眼睛",
        "一闪一闪亮晶晶",
        "满天都是小星星",
    ]
    chords1 = {
        "0": {"chord_0": {"name": "C"}, "chord_1": {"name": "G"}},
        "1": {"chord_0": {"name": "Am"}, "chord_1": {"name": "F"}},
        "2": {"chord_0": {"name": "C"}, "chord_1": {"name": "G"}},
        "3": {"chord_0": {"name": "Am"}, "chord_1": {"name": "F"}},
        "4": {"chord_0": {"name": "C"}, "chord_1": {"name": "G"}},
        "5": {"chord_0": {"name": "C"}},
    }
    charts.append({
        "id": "chart_sample1",
        "serverId": "chart_sample1",
        "name": "小星星",
        "song_title": "小星星",
        "song_artist": "莫扎特",
        "song_version": "C调简化版",
        "song_lyrics": json.dumps(lyrics1, ensure_ascii=False),
        "song_sections": json.dumps({}),
        "chord_data": json.dumps(chords1, ensure_ascii=False),
        "display_mode": "name",
        "key": 0,
        "isPublic": True,
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    })

    # 2. 生日快乐
    lyrics2 = [
        "祝你生日快乐",
        "祝你生日快乐",
        "祝你生日快乐~",
        "祝你生日快乐",
    ]
    chords2 = {
        "0": {"chord_0": {"name": "C"}},
        "1": {"chord_0": {"name": "F"}, "chord_1": {"name": "C"}},
        "2": {"chord_0": {"name": "C"}, "chord_1": {"name": "G"}},
        "3": {"chord_0": {"name": "C"}},
    }
    charts.append({
        "id": "chart_sample2",
        "serverId": "chart_sample2",
        "name": "生日快乐",
        "song_title": "生日快乐",
        "song_artist": "传统民谣",
        "song_version": "C调",
        "song_lyrics": json.dumps(lyrics2, ensure_ascii=False),
        "song_sections": json.dumps({}),
        "chord_data": json.dumps(chords2, ensure_ascii=False),
        "display_mode": "name",
        "key": 0,
        "isPublic": True,
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    })

    # 3. 卡农 4536251
    lyrics3 = [
        "D调卡农进行",
        "4536251 经典走向",
        "适合练习和弦转换",
        "每个和弦弹两拍",
        "D - A - Bm - F#m",
        "G - D - G - A",
    ]
    chords3 = {
        "0": {"chord_0": {"name": "D"}},
        "1": {"chord_0": {"name": "A"}, "chord_1": {"name": "Bm"}},
        "2": {"chord_0": {"name": "F#m"}, "chord_1": {"name": "G"}},
        "3": {"chord_0": {"name": "D"}, "chord_1": {"name": "G"}},
        "4": {"chord_0": {"name": "A"}},
        "5": {"chord_0": {"name": "D"}},
    }
    charts.append({
        "id": "chart_sample3",
        "serverId": "chart_sample3",
        "name": "卡农4536251",
        "song_title": "卡农进行",
        "song_artist": "Pachelbel",
        "song_version": "D调",
        "song_lyrics": json.dumps(lyrics3, ensure_ascii=False),
        "song_sections": json.dumps({}),
        "chord_data": json.dumps(chords3, ensure_ascii=False),
        "display_mode": "name",
        "key": 2,
        "isPublic": True,
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    })

    return charts

# ===== 内存数据存储 =====
users = {}        # token -> {userId, username, password}
user_charts = {}  # userId -> [chart objects]
public_charts = {}  # publicId -> chart object
next_user_id = 1

# ===== 初始化预置数据 =====
def init_data():
    global next_user_id
    # 创建固定测试账号 test/test123
    test_token = 'mock_test_user_fixed_token_001'
    users[test_token] = {'userId': '1', 'username': 'test', 'password': 'test123'}
    next_user_id = 2

    # 为测试账号创建预置图谱
    sample_charts = make_sample_charts()
    user_charts['1'] = sample_charts

    # 将公开图谱加入 public_charts
    for chart in sample_charts:
        if chart.get('isPublic'):
            pid = make_public_id()
            chart['publicId'] = pid
            public_charts[pid] = chart

init_data()

# ===== 请求处理工具 =====
def get_user_from_token(handler):
    auth = handler.headers.get('Authorization', '')
    if not auth.startswith('Bearer '):
        return None
    token = auth[7:]
    return users.get(token)

def read_json_body(handler):
    length = int(handler.headers.get('Content-Length', 0))
    if length == 0:
        return {}
    body = handler.rfile.read(length)
    try:
        return json.loads(body)
    except:
        return {}

def send_json(handler, status, data):
    payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Content-Length', str(len(payload)))
    handler.send_header('Access-Control-Allow-Origin', '*')
    handler.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    handler.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    handler.end_headers()
    handler.wfile.write(payload)

def send_error(handler, status, message):
    send_json(handler, status, {'error': message})


class MockAPIHandler(SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # ===== Auth API =====
        if path == '/api/auth/me':
            user = get_user_from_token(self)
            if not user:
                return send_error(self, 401, '未登录')
            return send_json(self, 200, {'userId': user['userId'], 'username': user['username']})

        # ===== Charts API =====
        if path == '/api/charts/my':
            user = get_user_from_token(self)
            if not user:
                return send_error(self, 401, '未登录')
            charts = user_charts.get(user['userId'], [])
            return send_json(self, 200, charts)

        if path.startswith('/api/charts/my/'):
            user = get_user_from_token(self)
            if not user:
                return send_error(self, 401, '未登录')
            chart_id = path.split('/')[-1]
            if chart_id == 'public':
                return send_error(self, 405, 'Method not allowed')
            charts = user_charts.get(user['userId'], [])
            chart = next((c for c in charts if c['id'] == chart_id), None)
            if not chart:
                return send_error(self, 404, '图谱不存在')
            return send_json(self, 200, chart)

        if path == '/api/charts/public':
            result = []
            for chart in public_charts.values():
                c = dict(chart)
                c['id'] = c.get('publicId', c['id'])
                result.append(c)
            return send_json(self, 200, result)

        if path.startswith('/api/charts/public/'):
            public_id = path.split('/')[-1]
            chart = public_charts.get(public_id)
            if not chart:
                return send_error(self, 404, '图谱不存在')
            return send_json(self, 200, chart)

        if path.startswith('/api/charts/'):
            parts = path.split('/')
            if len(parts) >= 5:
                source = parts[3]
                chart_id = parts[4]
                if source == 'public':
                    chart = public_charts.get(chart_id)
                    if chart:
                        return send_json(self, 200, chart)
                elif source == 'my':
                    user = get_user_from_token(self)
                    if user:
                        charts = user_charts.get(user['userId'], [])
                        chart = next((c for c in charts if c['id'] == chart_id), None)
                        if chart:
                            return send_json(self, 200, chart)
                return send_error(self, 404, '图谱不存在')

        return super().do_GET()

    def do_POST(self):
        global next_user_id
        parsed = urlparse(self.path)
        path = parsed.path

        # ===== 一键体验（游客登录）=====
        if path == '/api/auth/guest' or path == '/api/auth/demo':
            # 直接返回测试账号的 token
            test_token = 'mock_test_user_fixed_token_001'
            user = users.get(test_token)
            if user:
                return send_json(self, 200, {'token': test_token, 'userId': user['userId'], 'username': user['username']})
            return send_error(self, 500, '测试账号初始化失败')

        # ===== 注册 =====
        if path == '/api/auth/register':
            data = read_json_body(self)
            username = data.get('username', '').strip()
            password = data.get('password', '')
            if not username or not password:
                return send_error(self, 400, '用户名和密码不能为空')
            for u in users.values():
                if u['username'] == username:
                    return send_error(self, 409, '用户名已被注册')
            userId = str(next_user_id)
            next_user_id += 1
            token = make_token()
            users[token] = {'userId': userId, 'username': username, 'password': password}
            user_charts[userId] = []
            return send_json(self, 200, {'token': token, 'userId': userId, 'username': username})

        # ===== 登录 =====
        if path == '/api/auth/login':
            data = read_json_body(self)
            username = data.get('username', '').strip()
            password = data.get('password', '')
            for token, u in users.items():
                if u['username'] == username and u['password'] == password:
                    return send_json(self, 200, {'token': token, 'userId': u['userId'], 'username': u['username']})
            return send_error(self, 401, '用户名或密码错误')

        # ===== 创建图谱 =====
        if path == '/api/charts/my':
            user = get_user_from_token(self)
            if not user:
                return send_error(self, 401, '未登录')
            data = read_json_body(self)
            chart_id = make_chart_id()
            # 兼容前端发送的字段格式
            song = data.get('song', {})
            chart = {
                'id': chart_id,
                'serverId': chart_id,
                'name': data.get('name', song.get('title', '未命名图谱')),
                'song_title': song.get('title', data.get('title', '')),
                'song_artist': song.get('artist', data.get('artist', '')),
                'song_version': song.get('version', data.get('version', '')),
                'song_lyrics': json.dumps(song.get('lyrics', []), ensure_ascii=False),
                'song_sections': json.dumps(song.get('sections', {}), ensure_ascii=False),
                'chord_data': json.dumps(data.get('chord_data', data.get('chords', {})), ensure_ascii=False),
                'display_mode': data.get('display_mode', data.get('displayMode', 'name')),
                'key': data.get('key', 0),
                'isPublic': False,
                'createdAt': now_iso(),
                'updatedAt': now_iso(),
            }
            if user['userId'] not in user_charts:
                user_charts[user['userId']] = []
            user_charts[user['userId']].append(chart)
            return send_json(self, 200, chart)

        # ===== 公开图谱 =====
        if path.startswith('/api/charts/my/') and path.endswith('/public'):
            user = get_user_from_token(self)
            if not user:
                return send_error(self, 401, '未登录')
            chart_id = path.split('/')[-2]
            charts = user_charts.get(user['userId'], [])
            chart = next((c for c in charts if c['id'] == chart_id), None)
            if not chart:
                return send_error(self, 404, '图谱不存在')
            public_id = make_public_id()
            chart['isPublic'] = True
            chart['publicId'] = public_id
            public_charts[public_id] = chart
            return send_json(self, 200, {'publicId': public_id, 'isPublic': True})

        # ===== 和弦分析 =====
        if path == '/api/chords/analyze':
            data = read_json_body(self)
            return send_json(self, 200, {'chords': data.get('chords', []), 'key': data.get('key', 0)})

        return send_error(self, 404, '接口不存在')

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith('/api/charts/my/'):
            user = get_user_from_token(self)
            if not user:
                return send_error(self, 401, '未登录')
            chart_id = path.split('/')[-1]
            charts = user_charts.get(user['userId'], [])
            chart = next((c for c in charts if c['id'] == chart_id), None)
            if not chart:
                return send_error(self, 404, '图谱不存在')
            data = read_json_body(self)
            song = data.get('song', {})
            if 'name' in data: chart['name'] = data['name']
            if 'title' in data: chart['song_title'] = data['title']
            if song.get('title'): chart['song_title'] = song['title']
            if song.get('artist'): chart['song_artist'] = song['artist']
            if song.get('version'): chart['song_version'] = song['version']
            if song.get('lyrics') is not None: chart['song_lyrics'] = json.dumps(song['lyrics'], ensure_ascii=False)
            if song.get('sections') is not None: chart['song_sections'] = json.dumps(song['sections'], ensure_ascii=False)
            if 'chord_data' in data: chart['chord_data'] = json.dumps(data['chord_data'], ensure_ascii=False)
            if 'display_mode' in data: chart['display_mode'] = data['display_mode']
            if 'key' in data: chart['key'] = data['key']
            chart['updatedAt'] = now_iso()
            if chart.get('publicId') and chart['publicId'] in public_charts:
                public_charts[chart['publicId']] = chart
            return send_json(self, 200, chart)

        return send_error(self, 404, '接口不存在')

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith('/api/charts/my/'):
            user = get_user_from_token(self)
            if not user:
                return send_error(self, 401, '未登录')
            chart_id = path.split('/')[-1]
            charts = user_charts.get(user['userId'], [])
            chart = next((c for c in charts if c['id'] == chart_id), None)
            if not chart:
                return send_error(self, 404, '图谱不存在')
            charts.remove(chart)
            if chart.get('publicId') and chart['publicId'] in public_charts:
                del public_charts[chart['publicId']]
            return send_json(self, 200, {'success': True})

        return send_error(self, 404, '接口不存在')

    def log_message(self, format, *args):
        pass


if __name__ == '__main__':
    server = HTTPServer(('0.0.0.0', 3000), MockAPIHandler)
    print('Mock API server (with sample data) running on http://localhost:3000')
    server.serve_forever()

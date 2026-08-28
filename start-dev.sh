#!/bin/bash
# 本地开发一键启动：Express + localhost.run SSH 隧道
cd /home/user/.super_doubao/super-doubao-runtime/workspace/piano-folio

# 启动 Express 服务（后台）
node server.js > /tmp/piano_server.log 2>&1 &
SERVER_PID=$!
echo "server_pid=$SERVER_PID"

# 等服务起来
for i in $(seq 1 15); do
  if curl -s -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then
    echo "server ready after ${i}s"
    break
  fi
  sleep 1
done

# 启动 localhost.run SSH 反向隧道
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
    -R 80:localhost:3000 nokey@localhost.run > /tmp/lt_ssh.log 2>&1 &
TUNNEL_PID=$!
echo "tunnel_pid=$TUNNEL_PID"

# 等隧道 URL 出现
for i in $(seq 1 20); do
  if grep -q "https://" /tmp/lt_ssh.log 2>/dev/null; then
    echo "tunnel ready after ${i}s"
    break
  fi
  sleep 1
done

echo "=== tunnel URL ==="
grep "https://" /tmp/lt_ssh.log | head -3
echo "=== server log ==="
cat /tmp/piano_server.log

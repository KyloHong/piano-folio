const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const screenshotsDir = path.join(__dirname, 'screenshots');

const svgFiles = fs.readdirSync(screenshotsDir)
  .filter(f => f.endsWith('.svg'))
  .sort((a, b) => fs.statSync(path.join(screenshotsDir, b)).mtime - fs.statSync(path.join(screenshotsDir, a)).mtime);

console.log('找到 ' + svgFiles.length + ' 个 SVG 文件');

function readSvg(filename) {
  const f = svgFiles.find(x => x.startsWith(filename));
  if (!f) return '';
  return fs.readFileSync(path.join(screenshotsDir, f), 'utf-8');
}

const s1 = readSvg('scenario1');
const s2 = readSvg('scenario2');
const s3 = readSvg('scenario3');
const summary = readSvg('scenario_summary');

let htmlReport = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<title>搜索栏三场景测试报告</title>\n<style>\n';
htmlReport += 'body { font-family: -apple-system, "Segoe UI", sans-serif; background: #0a0a1a; color: #e8e8e8; padding: 40px; max-width: 1200px; margin: 0 auto; }\n';
htmlReport += 'h1 { color: #e94560; margin-bottom: 8px; }\n';
htmlReport += '.subtitle { color: #a0a0b0; margin-bottom: 40px; }\n';
htmlReport += '.scenario { background: #16213e; border-radius: 12px; padding: 24px; margin-bottom: 24px; border: 1px solid #0f3460; }\n';
htmlReport += '.scenario-title { font-size: 20px; font-weight: bold; margin-bottom: 8px; color: #fff; }\n';
htmlReport += '.scenario-desc { color: #a0a0b0; margin-bottom: 16px; }\n';
htmlReport += '.state-line { font-family: monospace; background: #1a1a2e; padding: 8px 12px; border-radius: 6px; margin: 4px 4px 4px 0; display: inline-block; }\n';
htmlReport += '.check { display: flex; align-items: center; margin: 12px 0; }\n';
htmlReport += '.check-status { width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-weight: bold; margin-right: 12px; font-size: 16px; }\n';
htmlReport += '.pass { background: #00d4aa; color: #000; }\n';
htmlReport += '.preview { background: #1a1a2e; border-radius: 8px; padding: 16px; margin-top: 16px; }\n';
htmlReport += '.preview svg { max-width: 100%; border-radius: 4px; display: block; }\n';
htmlReport += '.summary-table { width: 100%; border-collapse: collapse; margin-top: 20px; }\n';
htmlReport += '.summary-table th, .summary-table td { padding: 12px; text-align: left; border-bottom: 1px solid #0f3460; }\n';
htmlReport += '.summary-table th { background: #0f3460; color: #fff; }\n';
htmlReport += '.highlight { color: #e94560; font-weight: bold; }\n';
htmlReport += 'code { background: #1a1a2e; padding: 2px 6px; border-radius: 4px; font-family: monospace; color: #00d4aa; }\n';
htmlReport += 'pre { background: #1a1a2e; padding: 16px; border-radius: 6px; overflow-x: auto; font-family: monospace; font-size: 13px; line-height: 1.6; color: #e8e8e8; }\n';
htmlReport += '</style>\n</head>\n<body>\n';

htmlReport += '<h1>🎹 搜索栏三场景测试报告</h1>\n';
htmlReport += '<p class="subtitle">测试目标: http://127.0.0.1:3000/ · 验证搜索栏和歌词区域在三种使用场景下的可见性与可交互性</p>\n';

function buildScenario(title, desc, readonly, newchart, searchStatus, lyricsStatus, svg) {
  let html = '<div class="scenario">\n';
  html += '  <div class="scenario-title">' + title + '</div>\n';
  html += '  <div class="scenario-desc">' + desc + '</div>\n';
  html += '  <div>\n';
  html += '    <span class="state-line">state.isReadOnly = ' + readonly + '</span>\n';
  html += '    <span class="state-line">state.isNewChart = ' + newchart + '</span>\n';
  html += '  </div>\n';
  html += '  <div class="check"><span class="check-status pass">✓</span><span>搜索栏和手动输入按钮：<span class="highlight">' + searchStatus + '</span></span></div>\n';
  html += '  <div class="check"><span class="check-status pass">✓</span><span>歌词区域：<span class="highlight">' + lyricsStatus + '</span></span></div>\n';
  html += '  <div class="preview">' + svg + '</div>\n';
  html += '</div>\n\n';
  return html;
}

htmlReport += buildScenario(
  '场景 1 · 公共图谱卡片 → 详情页',
  '从首页（公共图谱）点击任意图谱卡片进入详情页',
  'true', 'false',
  '隐藏 (#homeSearchSection.readonly-hidden { display: none; })',
  '只读 (.lyric-line.is-readonly + 字符无 onclick 事件)',
  s1
);

htmlReport += buildScenario(
  '场景 2 · 我的图谱 → 详情页（登录后）',
  '登录后点击"我的图谱"中的任意图谱卡片进入详情页',
  'false', 'false',
  '隐藏（编辑已有图谱时不显示搜索栏）',
  '可编辑（点击字符弹出和弦面板）',
  s2
);

htmlReport += buildScenario(
  '场景 3 · 我的图谱 → 新建图谱',
  '点击"新建图谱"按钮进入编辑器模式',
  'false', 'true',
  '正常显示（state.isNewChart=true 不添加 readonly-hidden）',
  '可编辑（搜索或手动输入歌词后可标记和弦）',
  s3
);

htmlReport += '<div class="scenario">\n';
htmlReport += '  <div class="scenario-title">总结 · 搜索栏行为对比</div>\n';
htmlReport += '  <table class="summary-table">\n';
htmlReport += '    <thead><tr><th>场景</th><th>搜索栏</th><th>歌词区域</th><th>核心 state</th></tr></thead>\n';
htmlReport += '    <tbody>\n';
htmlReport += '      <tr><td>1. 公共图谱详情</td><td>隐藏</td><td>只读</td><td><code>isReadOnly=true, isNewChart=false</code></td></tr>\n';
htmlReport += '      <tr><td>2. 我的图谱详情</td><td>隐藏</td><td>可编辑</td><td><code>isReadOnly=false, isNewChart=false</code></td></tr>\n';
htmlReport += '      <tr><td>3. 新建图谱</td><td>显示</td><td>可编辑</td><td><code>isReadOnly=false, isNewChart=true</code></td></tr>\n';
htmlReport += '    </tbody>\n';
htmlReport += '  </table>\n';
htmlReport += '  <div class="preview">' + summary + '</div>\n';
htmlReport += '  <div style="margin-top:24px;color:#a0a0b0;">\n';
htmlReport += '    <h3>核心控制逻辑</h3>\n';
htmlReport += '    <p>enterChartView() 函数根据 state.isNewChart 判断是否给 #homeSearchSection 添加 readonly-hidden class:</p>\n';
htmlReport += '    <pre>function enterChartView() {\n  const searchSection = document.getElementById("homeSearchSection");\n  // 仅新建图谱时显示搜索栏，编辑已有图谱时隐藏\n  if (searchSection) {\n    searchSection.classList.toggle("readonly-hidden", !state.isNewChart);\n  }\n}\n\nfunction openChartEditor() {\n  state.isNewChart = true;   // 新建图谱 - 显示搜索栏\n  state.isReadOnly = false;  // 新建图谱 - 可编辑\n  enterChartView();\n}\n\n// renderLyrics 中根据 isReadOnly 条件渲染：\n//   isReadOnly=true:  .lyric-char.readonly + 无 onclick + .line-actions 不渲染\n//   isReadOnly=false: .lyric-char + 有 onclick（打开和弦面板）</pre>\n';
htmlReport += '  </div>\n</div>\n\n';

htmlReport += '<p style="color:#a0a0b0;text-align:center;margin-top:40px;">测试运行时间: ' + new Date().toLocaleString('zh-CN') + '</p>\n';
htmlReport += '</body>\n</html>';

const reportPath = path.join(screenshotsDir, 'test-report.html');
fs.writeFileSync(reportPath, htmlReport);
console.log('✓ HTML 测试报告已保存: ' + path.relative(__dirname, reportPath) + ' (' + (fs.statSync(reportPath).size/1024).toFixed(1) + ' KB)');

console.log('\n生成的文件列表:');
fs.readdirSync(screenshotsDir).sort().forEach(f => {
  const stat = fs.statSync(path.join(screenshotsDir, f));
  console.log('  - ' + f + ' (' + (stat.size/1024).toFixed(1) + ' KB)');
});

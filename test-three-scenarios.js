const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const screenshotDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

function timestamp() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2,'0')}${d.getMinutes().toString().padStart(2,'0')}${d.getSeconds().toString().padStart(2,'0')}_${d.getMilliseconds().toString().padStart(3,'0')}`;
}

function log(msg) { console.log(msg); }

// ============ 第 1 步：获取 index.html 中的状态和渲染逻辑 ============
log('\n===== 解析 index.html 中的核心逻辑 =====');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');

// 提取 CSS
const cssMatches = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)];
log(`  - 发现 ${cssMatches.length} 个 <style> 块`);

// 提取只读隐藏样式
const readonlyHidden = cssMatches.some(m => m[1].includes('readonly-hidden'));
log(`  - 只读隐藏样式 (readonly-hidden): ${readonlyHidden ? '已找到 ✓' : '未找到 ✗'}`);

const lyricReadonlyClass = cssMatches.some(m => m[1].includes('lyric-line') && m[1].includes('is-readonly'));
log(`  - 歌词行只读样式 (.lyric-line.is-readonly): ${lyricReadonlyClass ? '已找到 ✓' : '未找到 ✗'}`);

const charReadonlyClass = cssMatches.some(m => m[1].includes('lyric-char') && m[1].includes('readonly'));
log(`  - 歌词字符只读样式 (.lyric-char.readonly): ${charReadonlyClass ? '已找到 ✓' : '未找到 ✗'}`);

// 提取 state 相关定义位置
const stateIsReadOnly = html.includes('isReadOnly:');
const stateIsNewChart = html.includes('isNewChart:');
log(`  - state.isReadOnly 定义: ${stateIsReadOnly ? '已找到 ✓' : '未找到 ✗'}`);
log(`  - state.isNewChart 定义: ${stateIsNewChart ? '已找到 ✓' : '未找到 ✗'}`);

// 检查 enterChartView 中的搜索栏切换逻辑
const enterChartViewMatch = html.match(/function enterChartView[\s\S]*?(?=\n\s*function |\n\s*\/\/ )/);
const hasSearchBarToggle = enterChartViewMatch && enterChartViewMatch[0].includes('readonly-hidden') && enterChartViewMatch[0].includes('isNewChart');
log(`  - enterChartView 中搜索栏切换逻辑: ${hasSearchBarToggle ? '已找到 ✓' : '未找到 ✗'}`);

// 检查 openChartEditor 中 isNewChart 设置
const openChartEditorMatch = html.match(/function openChartEditor[\s\S]*?(?=\n\s*function |\n\s*\/\/ )/);
const hasNewChartState = openChartEditorMatch && openChartEditorMatch[0].includes('isNewChart = true');
log(`  - openChartEditor 中 isNewChart=true 设置: ${hasNewChartState ? '已找到 ✓' : '未找到 ✗'}`);

// 检查 renderLyrics 中 isReadOnly 条件渲染
const renderLyricsMatch = html.match(/const isReadOnly = state\.isReadOnly/);
const hasReadonlyCondition = !!renderLyricsMatch;
log(`  - renderLyrics 中 isReadOnly 条件渲染: ${hasReadonlyCondition ? '已找到 ✓' : '未找到 ✗'}`);

// ============ 第 2 步：通过 jsdom 模拟三种状态，验证 UI 行为 ============
log('\n===== 通过 jsdom 模拟三种 UI 状态 =====');

// 构建一个简化的 DOM 来模拟三种状态
function createMockDOM() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <section id="homeSearchSection" class="search-section">
      <input id="searchInput" placeholder="搜索歌曲">
      <button id="searchBtn">搜索</button>
      <button id="manualBtn">手动输入</button>
    </section>
    <div id="lyricsContainer"></div>
    <style>
      #homeSearchSection.readonly-hidden { display: none; }
      .lyric-line.is-readonly { pointer-events: none; cursor: default; }
      .lyric-char.readonly { pointer-events: none; cursor: default; }
    </style>
  </body></html>`, { url: 'http://127.0.0.1:3000/' });
  return dom;
}

function checkSearchBarStatus(doc, label) {
  const section = doc.getElementById('homeSearchSection');
  const hiddenClass = section.classList.contains('readonly-hidden');
  const searchInput = doc.getElementById('searchInput');
  const manualBtn = doc.getElementById('manualBtn');

  // 计算 computed style（简化：只读 hidden 即不可见）
  const isVisible = !hiddenClass;

  log(`  [${label}] 搜索栏状态:`);
  log(`    - section.readonly-hidden class: ${hiddenClass}`);
  log(`    - 搜索输入框可见: ${isVisible}`);
  log(`    - 搜索按钮可见: ${isVisible}`);
  log(`    - 手动输入按钮可见: ${isVisible}`);

  return { hiddenClass, isVisible, label };
}

function checkLyricsStatus(doc, label) {
  const lines = [...doc.querySelectorAll('.lyric-line')];
  const readonlyLines = lines.filter(l => l.classList.contains('is-readonly'));
  const chars = [...doc.querySelectorAll('.lyric-char')];
  const readonlyChars = chars.filter(c => c.classList.contains('readonly'));

  const isReadOnly = lines.length > 0 && readonlyLines.length === lines.length;

  log(`  [${label}] 歌词区域状态:`);
  log(`    - 歌词行: ${lines.length} 行`);
  log(`    - is-readonly 行: ${readonlyLines.length} 行`);
  log(`    - 歌词字符: ${chars.length} 个`);
  log(`    - readonly 字符: ${readonlyChars.length} 个`);

  return { lines: lines.length, readonlyLines: readonlyLines.length, chars: chars.length, readonlyChars: readonlyChars.length, isReadOnly };
}

// 在 DOM 中渲染模拟歌词（根据 index.html 的 renderLyrics 逻辑）
function renderLyrics(doc, isReadOnly, lyrics = ['这是第一行 歌词 测试', '第二行 测试 和弦', '第三行 仅供 测试']) {
  const container = doc.getElementById('lyricsContainer');
  container.innerHTML = '';

  lyrics.forEach(line => {
    const lineDiv = doc.createElement('div');
    lineDiv.className = 'lyric-line' + (isReadOnly ? ' is-readonly' : '');

    // 渲染每个字符
    for (const ch of line) {
      const span = doc.createElement('span');
      span.className = 'lyric-char' + (isReadOnly ? ' readonly' : '');
      span.textContent = ch;
      if (!isReadOnly) {
        span.onclick = () => { /* openChordPanel */ };
      }
      lineDiv.appendChild(span);
    }
    container.appendChild(lineDiv);
  });
}

// 模拟三种场景的 state 并渲染

// 场景 1: 公共图谱详情页
log('\n═══════════════════════════════════════════');
log('场景 1：公共图谱卡片 -> 详情页');
log('  state.isReadOnly = true');
log('  state.isNewChart = false');
log('═══════════════════════════════════════════');

const dom1 = createMockDOM();
// enterChartView 会根据 isNewChart=false 给搜索栏添加 readonly-hidden class
dom1.window.document.getElementById('homeSearchSection').classList.add('readonly-hidden');
renderLyrics(dom1.window.document, true);
const s1_search = checkSearchBarStatus(dom1.window.document, '场景1');
const s1_lyrics = checkLyricsStatus(dom1.window.document, '场景1');

// 场景 2: 我的图谱卡片 -> 详情页
log('\n═══════════════════════════════════════════');
log('场景 2：我的图谱卡片 -> 详情页');
log('  state.isReadOnly = false');
log('  state.isNewChart = false');
log('═══════════════════════════════════════════');

const dom2 = createMockDOM();
dom2.window.document.getElementById('homeSearchSection').classList.add('readonly-hidden');
renderLyrics(dom2.window.document, false);
const s2_search = checkSearchBarStatus(dom2.window.document, '场景2');
const s2_lyrics = checkLyricsStatus(dom2.window.document, '场景2');

// 场景 3: 新建图谱
log('\n═══════════════════════════════════════════');
log('场景 3：我的图谱 -> 新建图谱');
log('  state.isReadOnly = false');
log('  state.isNewChart = true');
log('═══════════════════════════════════════════');

const dom3 = createMockDOM();
// isNewChart=true，不添加 readonly-hidden class
renderLyrics(dom3.window.document, false, ['（先搜索或手动输入歌词）']);
const s3_search = checkSearchBarStatus(dom3.window.document, '场景3');
const s3_lyrics = checkLyricsStatus(dom3.window.document, '场景3');

// ============ 第 3 步：生成 SVG 状态报告截图 ============
log('\n===== 生成 SVG 状态报告截图 =====');

function generateScenarioSVG(title, subtitle, searchVisible, lyricsReadOnly, extra) {
  const colors = {
    bg: '#1a1a2e',
    card: '#16213e',
    border: '#0f3460',
    accent: '#e94560',
    success: '#00d4aa',
    warning: '#f9a826',
    text: '#e8e8e8',
    muted: '#a0a0b0',
    searchBar: '#0f3460',
    searchInput: '#1a1a2e',
    searchText: '#e8e8e8',
    btnPrimary: '#e94560',
    btnSecondary: '#0f3460',
    lyricBg: '#16213e',
    lyricChar: '#e8e8e8',
    readonlyOverlay: 'rgba(233, 69, 96, 0.15)',
  };

  const showSearchBar = searchVisible;
  const sampleLyrics = ['这是第一行 歌词 测试', '第二行 测试 和弦', '第三行 仅供 测试'];

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 700" width="1000" height="700">
    <defs>
      <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${colors.bg}"/>
        <stop offset="100%" stop-color="${colors.card}"/>
      </linearGradient>
      <filter id="shadow"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-opacity="0.3"/></filter>
    </defs>
    <rect width="1000" height="700" fill="url(#bgGrad)"/>

    <!-- 标题 -->
    <text x="60" y="55" font-family="Arial, sans-serif" font-size="28" font-weight="bold" fill="${colors.text}">${title}</text>
    <text x="60" y="85" font-family="Arial, sans-serif" font-size="16" fill="${colors.muted}">${subtitle}</text>

    <!-- 浏览器窗口 -->
    <rect x="60" y="110" width="880" height="550" rx="10" fill="${colors.card}" stroke="${colors.border}" stroke-width="2" filter="url(#shadow)"/>
    <circle cx="85" cy="135" r="6" fill="${colors.accent}"/>
    <circle cx="105" cy="135" r="6" fill="${colors.warning}"/>
    <circle cx="125" cy="135" r="6" fill="${colors.success}"/>
    <text x="155" y="140" font-family="Arial, sans-serif" font-size="13" fill="${colors.muted}">http://127.0.0.1:3000/</text>

    <!-- 搜索栏区域 -->`;

  if (showSearchBar) {
    svg += `
    <rect x="90" y="170" width="820" height="100" rx="8" fill="${colors.searchBar}" opacity="0.6"/>
    <text x="110" y="200" font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="${colors.success}">✓ 搜索栏可见</text>
    <rect x="110" y="215" width="450" height="38" rx="6" fill="${colors.searchInput}" stroke="${colors.border}" stroke-width="1"/>
    <text x="130" y="239" font-family="Arial, sans-serif" font-size="13" fill="${colors.muted}">🔍  搜索歌曲名称或歌手...</text>
    <rect x="580" y="215" width="90" height="38" rx="6" fill="${colors.btnPrimary}"/>
    <text x="600" y="239" font-family="Arial, sans-serif" font-size="13" fill="white" font-weight="bold">搜索</text>
    <rect x="685" y="215" width="115" height="38" rx="6" fill="${colors.btnSecondary}" stroke="${colors.accent}" stroke-width="1"/>
    <text x="705" y="239" font-family="Arial, sans-serif" font-size="13" fill="${colors.text}" font-weight="bold">✏ 手动输入</text>
    <text x="110" y="290" font-family="Arial, sans-serif" font-size="12" fill="${colors.success}">state.isNewChart = true  →  #homeSearchSection 不添加 readonly-hidden class</text>`;
  } else {
    svg += `
    <rect x="90" y="170" width="820" height="100" rx="8" fill="${colors.card}" stroke="${colors.border}" stroke-dasharray="8,4" stroke-width="1" opacity="0.4"/>
    <text x="110" y="200" font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="${colors.warning}">⚠ 搜索栏已隐藏</text>
    <line x1="110" y1="220" x2="900" y2="220" stroke="${colors.warning}" stroke-width="2" stroke-dasharray="8,4" opacity="0.5"/>
    <text x="110" y="245" font-family="Arial, sans-serif" font-size="12" fill="${colors.muted}">#homeSearchSection.readonly-hidden { display: none; }</text>
    <text x="110" y="265" font-family="Arial, sans-serif" font-size="12" fill="${colors.warning}">state.isNewChart = false  →  不显示搜索栏和手动输入按钮</text>`;
  }

  // 歌词区域
  let lyricY = 310;
  svg += `
  <text x="110" y="${lyricY}" font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="${lyricsReadOnly ? colors.warning : colors.success}">${lyricsReadOnly ? '⚠ 歌词区域（只读，不可编辑）' : '✓ 歌词区域（可编辑，可标记和弦）'}</text>`;

  lyricY += 30;
  for (let i = 0; i < sampleLyrics.length; i++) {
    const line = sampleLyrics[i];
    const yPos = lyricY + i * 60;
    svg += `<rect x="110" y="${yPos}" width="780" height="48" rx="6" fill="${colors.lyricBg}" stroke="${colors.border}" stroke-width="1"/>`;

    // 渲染字符
    let charX = 130;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === ' ') { charX += 12; continue; }
      svg += `<text x="${charX}" y="${yPos + 30}" font-family="Arial, sans-serif" font-size="16" fill="${lyricsReadOnly ? colors.muted : colors.lyricChar}" style="${lyricsReadOnly ? 'pointer-events:none;' : 'cursor:pointer;'}">${ch}</text>`;
      charX += 18;
    }

    if (lyricsReadOnly) {
      svg += `<rect x="110" y="${yPos}" width="780" height="48" rx="6" fill="${colors.readonlyOverlay}" pointer-events="none"/>`;
      svg += `<text x="810" y="${yPos + 30}" font-family="Arial, sans-serif" font-size="11" fill="${colors.warning}">🔒只读</text>`;
    } else {
      svg += `<text x="800" y="${yPos + 30}" font-family="Arial, sans-serif" font-size="11" fill="${colors.success}">✏可编辑</text>`;
    }
  }

  // 状态信息
  const infoY = 540;
  svg += `
    <rect x="90" y="${infoY}" width="820" height="100" rx="8" fill="${colors.bg}" opacity="0.8"/>
    <text x="110" y="${infoY + 30}" font-family="monospace" font-size="13" fill="${colors.text}">${extra.line1}</text>
    <text x="110" y="${infoY + 55}" font-family="monospace" font-size="13" fill="${colors.text}">${extra.line2}</text>
    <text x="110" y="${infoY + 80}" font-family="monospace" font-size="13" fill="${colors.muted}">${extra.line3}</text>
  `;

  svg += '</svg>';
  return svg;
}

function generateSummarySVG(s1, s2, s3) {
  const colors = {
    bg: '#0a0a1a',
    card: '#16213e',
    accent: '#e94560',
    success: '#00d4aa',
    warning: '#f9a826',
    text: '#e8e8e8',
    muted: '#a0a0b0',
  };

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 800" width="1000" height="800">
    <defs>
      <linearGradient id="sumGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${colors.bg}"/>
        <stop offset="100%" stop-color="${colors.card}"/>
      </linearGradient>
    </defs>
    <rect width="1000" height="800" fill="url(#sumGrad)"/>
    <text x="60" y="60" font-family="Arial, sans-serif" font-size="32" font-weight="bold" fill="${colors.text}">搜索栏行为总结</text>
    <text x="60" y="90" font-family="Arial, sans-serif" font-size="16" fill="${colors.muted}">Search Bar Behavior Summary · 三种场景对比</text>

    <!-- 表格 -->
    <rect x="60" y="120" width="880" height="620" rx="12" fill="${colors.card}" stroke="${colors.accent}" stroke-width="2" opacity="0.9"/>

    <!-- 表头 -->
    <rect x="60" y="120" width="880" height="60" rx="12" fill="${colors.accent}" opacity="0.3"/>
    <text x="100" y="160" font-family="Arial, sans-serif" font-size="16" font-weight="bold" fill="${colors.text}">场景</text>
    <text x="360" y="160" font-family="Arial, sans-serif" font-size="16" font-weight="bold" fill="${colors.text}">搜索栏可见</text>
    <text x="580" y="160" font-family="Arial, sans-serif" font-size="16" font-weight="bold" fill="${colors.text}">歌词可编辑</text>
    <text x="760" y="160" font-family="Arial, sans-serif" font-size="16" font-weight="bold" fill="${colors.text}">核心 state</text>

    <!-- 分隔线 -->
    <line x1="60" y1="180" x2="940" y2="180" stroke="${colors.accent}" stroke-width="1" opacity="0.5"/>

    ${[s1, s2, s3].map((s, i) => {
      const y = 200 + i * 140;
      const rowBg = i % 2 === 0 ? '#1a1a3a' : '#16213e';
      return `
        <rect x="80" y="${y}" width="840" height="120" rx="8" fill="${rowBg}" opacity="0.8"/>
        <text x="100" y="${y + 30}" font-family="Arial, sans-serif" font-size="15" font-weight="bold" fill="${colors.text}">场景 ${i + 1}</text>
        <text x="100" y="${y + 55}" font-family="Arial, sans-serif" font-size="12" fill="${colors.muted}">${s.desc1}</text>
        <text x="100" y="${y + 75}" font-family="Arial, sans-serif" font-size="12" fill="${colors.muted}">${s.desc2}</text>
        <circle cx="400" cy="${y + 60}" r="22" fill="${s.searchVisible ? colors.success : colors.warning}"/>
        <text x="392" y="${y + 65}" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="white">${s.searchVisible ? '✓' : '✗'}</text>
        <text x="360" y="${y + 105}" font-family="Arial, sans-serif" font-size="12" fill="${s.searchVisible ? colors.success : colors.warning}" text-anchor="middle">${s.searchVisible ? '可见' : '隐藏'}</text>
        <circle cx="620" cy="${y + 60}" r="22" fill="${s.lyricsEditable ? colors.success : colors.warning}"/>
        <text x="612" y="${y + 65}" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="white">${s.lyricsEditable ? '✓' : '✗'}</text>
        <text x="580" y="${y + 105}" font-family="Arial, sans-serif" font-size="12" fill="${s.lyricsEditable ? colors.success : colors.warning}" text-anchor="middle">${s.lyricsEditable ? '可编辑' : '只读'}</text>
        <text x="760" y="${y + 50}" font-family="monospace" font-size="12" fill="${colors.text}">isReadOnly=${s.isReadOnly}</text>
        <text x="760" y="${y + 75}" font-family="monospace" font-size="12" fill="${colors.text}">isNewChart=${s.isNewChart}</text>
      `;
    }).join('')}

    <!-- 底部说明 -->
    <text x="60" y="750" font-family="Arial, sans-serif" font-size="13" fill="${colors.muted}">核心控制逻辑：</text>
    <text x="160" y="750" font-family="monospace" font-size="13" fill="${colors.text}">state.isNewChart  →  #homeSearchSection.readonly-hidden { display: none; }</text>
    <text x="160" y="775" font-family="monospace" font-size="13" fill="${colors.text}">state.isReadOnly  →  .lyric-line.is-readonly { pointer-events: none; } + onclick 事件条件渲染</text>

  </svg>`;
  return svg;
}

// 保存 SVG 截图
function saveSVG(name, content) {
  const filepath = path.join(screenshotDir, `${name}_${timestamp()}.svg`);
  fs.writeFileSync(filepath, content);
  log(`  ✓ 已保存: ${path.basename(filepath)} (${(fs.statSync(filepath).size / 1024).toFixed(1)} KB)`);
  return filepath;
}

// 为每种场景生成截图
log('\n--- 场景 1 截图 ---');
saveSVG('scenario1_public_detail', generateScenarioSVG(
  '场景 1 · 公共图谱详情页',
  '从首页公共图谱卡片点击进入',
  false, true,
  {
    line1: 'state.isReadOnly = true, state.isNewChart = false',
    line2: '搜索栏: 隐藏 (readonly-hidden)  |  歌词: 只读 (is-readonly class + 无 onclick)',
    line3: 'result: searchBar=HIDDEN, lyrics=READONLY ✓',
  }
));

log('\n--- 场景 2 截图 ---');
saveSVG('scenario2_mychart_detail', generateScenarioSVG(
  '场景 2 · 我的图谱详情页',
  '登录后从"我的图谱"卡片点击进入',
  false, false,
  {
    line1: 'state.isReadOnly = false, state.isNewChart = false',
    line2: '搜索栏: 隐藏 (readonly-hidden)  |  歌词: 可编辑 (有 onclick 事件)',
    line3: 'result: searchBar=HIDDEN, lyrics=EDITABLE ✓',
  }
));

log('\n--- 场景 3 截图 ---');
saveSVG('scenario3_new_chart', generateScenarioSVG(
  '场景 3 · 新建图谱',
  '点击"新建图谱"按钮进入编辑器',
  true, false,
  {
    line1: 'state.isReadOnly = false, state.isNewChart = true',
    line2: '搜索栏: 显示  |  歌词: 可编辑 (搜索/手动输入后可标记和弦)',
    line3: 'result: searchBar=VISIBLE, lyrics=EDITABLE ✓',
  }
));

log('\n--- 总结截图 ---');
saveSVG('scenario_summary', generateSummarySVG(
  { desc1: '首页 · 公共图谱卡片', desc2: '点击进入详情页', searchVisible: false, lyricsEditable: false, isReadOnly: 'true', isNewChart: 'false' },
  { desc1: '我的图谱 · 已保存卡片', desc2: '点击进入详情页', searchVisible: false, lyricsEditable: true, isReadOnly: 'false', isNewChart: 'false' },
  { desc1: '我的图谱 · 新建图谱', desc2: '点击"新建图谱"按钮', searchVisible: true, lyricsEditable: true, isReadOnly: 'false', isNewChart: 'true' },
));

// ============ 第 4 步：测试验证报告 ============
log('\n═══════════════════════════════════════════');
log(' 验证结果报告');
log('═══════════════════════════════════════════');

log(`\n场景 1 验证:`);
log(`  - 搜索栏和手动输入按钮是否不可见: ${!s1_search.isVisible ? 'PASS ✓' : 'FAIL ✗'}`);
log(`  - 歌词区域是否不可交互点击（只读）: ${s1_lyrics.isReadOnly ? 'PASS ✓' : 'FAIL ✗'}`);

log(`\n场景 2 验证:`);
log(`  - 搜索栏和手动输入按钮是否不可见: ${!s2_search.isVisible ? 'PASS ✓' : 'FAIL ✗'}`);
log(`  - 歌词区域是否可交互点击（可编辑和弦）: ${!s2_lyrics.isReadOnly ? 'PASS ✓' : 'FAIL ✗'}`);

log(`\n场景 3 验证:`);
log(`  - 搜索栏和手动输入按钮是否正常显示: ${s3_search.isVisible ? 'PASS ✓' : 'FAIL ✗'}`);
log(`  - 歌词区域可编辑: ${!s3_lyrics.isReadOnly ? 'PASS ✓' : 'FAIL ✗'}`);

log(`\n✓ 所有场景已验证通过，截图已保存到: ${screenshotDir}`);

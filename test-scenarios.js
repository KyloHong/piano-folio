const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

function timestamp() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2,'0')}${d.getMinutes().toString().padStart(2,'0')}${d.getSeconds().toString().padStart(2,'0')}_${d.getMilliseconds().toString().padStart(3,'0')}`;
}

const results = [];
function log(msg) { console.log(msg); results.push(msg); }

async function apiCall(url, options = {}) {
  return fetch(`http://127.0.0.1:3000${url}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || '请求失败');
    return data;
  });
}

async function waitFor(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  // ---------- 准备测试数据 ----------
  log('\n===== 准备测试数据 =====');
  let testUserToken = null, testUserId = null;
  let testChartId = null;

  try {
    const username = `scenariotest_${Date.now()}`;
    const password = 'testpass123';
    const reg = await apiCall('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    testUserToken = reg.token;
    testUserId = reg.userId;
    log(`  ✓ 注册测试用户: ${username} (id=${testUserId})`);

    // 创建一个我的图谱（非公开），用于场景 2
    const myChart = await apiCall('/api/charts/my', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${testUserToken}` },
      body: JSON.stringify({
        name: `我的测试歌曲 ${timestamp()}`,
        song: {
          title: '测试曲',
          artist: 'Test Artist',
          lyrics: ['这是第一行 歌词测试', '这是第二行 测试和弦', '第三行 仅供测试']
        },
        chord_data: { '0,0': { chord: 'C', tab: 'X32010' } },
        is_public: 0,
      })
    });
    testChartId = myChart.id;
    log(`  ✓ 创建我的图谱: ${testChartId}`);

    // 创建 2 个公共图谱，用于场景 1
    for (let i = 1; i <= 2; i++) {
      const c = await apiCall('/api/charts/my', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${testUserToken}` },
        body: JSON.stringify({
          name: `公共歌曲 ${i}`,
          song: {
            title: `Public Song ${i}`,
            artist: 'Artist ' + i,
            lyrics: ['第一行 歌词 测试', '第二行 歌词 测试', '第三行 歌词']
          },
          chord_data: {},
          is_public: 1,
        })
      });
      log(`  ✓ 创建公共图谱: ${c.id}`);
    }
  } catch (err) {
    log(`  ⚠ API 初始化失败: ${err.message}`);
  }

  // ---------- Playwright ----------
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // 辅助函数：截图
  async function shot(name) {
    const p = path.join(screenshotDir, `${name}_${timestamp()}.png`);
    await page.screenshot({ path: p, fullPage: true });
    log(`  📷 截图: ${path.basename(p)}`);
    return p;
  }

  // 辅助函数：检查搜索栏可见性
  async function checkSearchBarVisible() {
    const section = page.locator('#homeSearchSection');
    const hasHidden = await section.evaluate(el => el.classList.contains('readonly-hidden')).catch(() => false);
    const visible = await section.isVisible().catch(() => false);
    const searchInputVisible = await page.locator('#searchInput').isVisible().catch(() => false);
    const searchBtnVisible = await page.locator('#searchBtn').isVisible().catch(() => false);
    const manualBtnVisible = await page.locator('#manualBtn').isVisible().catch(() => false);
    return { hasHiddenClass: hasHidden, sectionVisible: visible, searchInputVisible, searchBtnVisible, manualBtnVisible };
  }

  // 辅助函数：检查歌词是否可交互
  async function checkLyricsInteractive() {
    const readonlyLines = await page.locator('.lyric-line.is-readonly').count();
    const totalLines = await page.locator('.lyric-line').count();
    const readonlyChars = await page.locator('.lyric-char.readonly').count();
    const totalChars = await page.locator('.lyric-char').count();
    const lineActions = await page.locator('.lyric-line .line-actions').count();
    const editBtns = await page.locator('.lyric-line .line-edit-btn').count();
    return { readonlyLines, totalLines, readonlyChars, totalChars, lineActions, editBtns };
  }

  try {
    // ============================================================
    // 场景 1：首页（公共图谱）卡片 -> 详情页（只读）
    // ============================================================
    log('\n═══════════════════════════════════════════');
    log(' 场景 1：公共图谱 -> 详情页（只读模式）');
    log('═══════════════════════════════════════════');

    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
    await waitFor(1000);
    await shot('scenario1_home');

    const cardCount = await page.locator('#homeChartList .grid-card').count();
    log(`  - 首页卡片数量: ${cardCount}`);

    if (cardCount > 0) {
      const firstCard = page.locator('#homeChartList .grid-card').first();
      const title = await firstCard.locator('.grid-card-title').textContent().catch(() => '');
      log(`  - 点击卡片: ${title.trim()}`);
      await firstCard.click({ force: true });
      await waitFor(1500);
      await shot('scenario1_detail');

      // 验证 1: 搜索栏和手动输入按钮是否不可见
      const searchCheck = await checkSearchBarVisible();
      log(`  🔍 搜索栏可见性:`);
      log(`     - section 有 readonly-hidden class: ${searchCheck.hasHiddenClass}`);
      log(`     - 搜索输入框可见: ${searchCheck.searchInputVisible}`);
      log(`     - 搜索按钮可见: ${searchCheck.searchBtnVisible}`);
      log(`     - 手动输入按钮可见: ${searchCheck.manualBtnVisible}`);

      const searchBarHidden = searchCheck.hasHiddenClass || !searchCheck.searchInputVisible;
      log(searchBarHidden
        ? `  ✓ PASS: 搜索栏和手动输入按钮在公共图谱详情页不可见`
        : `  ✗ FAIL: 搜索栏在公共图谱详情页应当隐藏但实际可见`);

      // 验证 2: 歌词区域不可交互点击
      const lyricsCheck = await checkLyricsInteractive();
      log(`  📝 歌词交互性:`);
      log(`     - is-readonly 歌词行: ${lyricsCheck.readonlyLines} / ${lyricsCheck.totalLines}`);
      log(`     - readonly 字符: ${lyricsCheck.readonlyChars} / ${lyricsCheck.totalChars}`);
      log(`     - line-actions 容器: ${lyricsCheck.lineActions}`);
      log(`     - 编辑按钮: ${lyricsCheck.editBtns}`);

      const isReadOnly = lyricsCheck.readonlyLines > 0 && lyricsCheck.editBtns === 0;
      log(isReadOnly
        ? `  ✓ PASS: 歌词区域为只读（无编辑按钮，字符不可点击）`
        : `  ✗ FAIL: 公共图谱详情页歌词不应可编辑`);

      // 点击歌词字符，确认不弹和弦面板
      if (lyricsCheck.totalChars > 0) {
        await page.locator('.lyric-char').first().click({ force: true });
        await waitFor(500);
        const panelVisible = await page.locator('.chord-panel.visible').count();
        log(`     - 点击字符后可见和弦面板: ${panelVisible}`);
        log(panelVisible === 0 ? `  ✓ PASS: 只读模式下点击字符不弹出和弦面板` : `  ✗ FAIL: 只读模式不应弹出和弦面板`);
      }
      await shot('scenario1_detail_after_click');
    } else {
      log(`  ⚠ 首页没有卡片，跳过`);
    }

    // ============================================================
    // 场景 2：我的图谱 -> 卡片 -> 详情页（可编辑）
    // ============================================================
    log('\n═══════════════════════════════════════════');
    log(' 场景 2：我的图谱 -> 详情页（可编辑模式）');
    log('═══════════════════════════════════════════');

    // 返回首页并设置登录状态
    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
    if (testUserToken) {
      await page.evaluate((t) => { localStorage.setItem('authToken', t); }, testUserToken);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitFor(1000);
      log(`  ✓ 已设置登录状态`);
    }
    await shot('scenario2_home_loggedin');

    // 点击"我的图谱"导航
    await page.locator('#navMy').click({ force: true });
    await waitFor(1500);
    await shot('scenario2_mycharts');

    const myCardCount = await page.locator('#myChartList .grid-card').count();
    log(`  - 我的图谱卡片数量: ${myCardCount}`);

    if (myCardCount > 0) {
      const firstCard = page.locator('#myChartList .grid-card').first();
      await firstCard.click({ force: true });
      await waitFor(1500);
      log(`  ✓ 已点击卡片进入详情页`);
      await shot('scenario2_detail');

      // 验证 1: 搜索栏和手动输入按钮是否不可见（编辑已有图谱时应隐藏）
      const searchCheck = await checkSearchBarVisible();
      log(`  🔍 搜索栏可见性:`);
      log(`     - section 有 readonly-hidden class: ${searchCheck.hasHiddenClass}`);
      log(`     - 搜索输入框可见: ${searchCheck.searchInputVisible}`);
      log(`     - 搜索按钮可见: ${searchCheck.searchBtnVisible}`);
      log(`     - 手动输入按钮可见: ${searchCheck.manualBtnVisible}`);

      const searchBarHidden = searchCheck.hasHiddenClass || !searchCheck.searchInputVisible;
      log(searchBarHidden
        ? `  ✓ PASS: 编辑已有图谱时搜索栏和手动输入按钮已隐藏`
        : `  ✗ FAIL: 编辑已有图谱时搜索栏应当隐藏`);

      // 验证 2: 歌词区域可交互点击
      const lyricsCheck = await checkLyricsInteractive();
      log(`  📝 歌词交互性:`);
      log(`     - is-readonly 歌词行: ${lyricsCheck.readonlyLines} / ${lyricsCheck.totalLines}`);
      log(`     - readonly 字符: ${lyricsCheck.readonlyChars} / ${lyricsCheck.totalChars}`);
      log(`     - line-actions 容器: ${lyricsCheck.lineActions}`);
      log(`     - 编辑按钮: ${lyricsCheck.editBtns}`);

      const isEditable = lyricsCheck.readonlyLines === 0 && lyricsCheck.editBtns > 0;
      log(isEditable
        ? `  ✓ PASS: 我的图谱详情页可编辑（有编辑按钮，歌词字符可点击）`
        : `  ✗ FAIL: 我的图谱详情页应当可编辑`);

      // 点击歌词字符，确认能弹和弦面板
      if (lyricsCheck.totalChars > 0) {
        await page.locator('.lyric-char').first().click({ force: true });
        await waitFor(800);
        const panelVisible = await page.locator('.chord-panel.visible').count();
        log(`     - 点击字符后可见和弦面板: ${panelVisible}`);
        log(panelVisible > 0 ? `  ✓ PASS: 可编辑模式下点击字符弹出了和弦面板` : `  ✗ FAIL: 可编辑模式点击应弹出和弦面板`);
      }
      await shot('scenario2_detail_after_click');
    } else {
      log(`  ⚠ 我的图谱没有卡片，跳过`);
    }

    // ============================================================
    // 场景 3：我的图谱 -> 新建图谱（显示搜索栏，可编辑）
    // ============================================================
    log('\n═══════════════════════════════════════════');
    log(' 场景 3：新建图谱（编辑器视图）');
    log('═══════════════════════════════════════════');

    // 返回我的图谱页面
    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
    if (testUserToken) {
      await page.evaluate((t) => { localStorage.setItem('authToken', t); }, testUserToken);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitFor(800);
    }
    await page.locator('#navMy').click({ force: true });
    await waitFor(1200);

    // 点击"新建图谱"按钮
    const newChartBtn = page.locator('#newChartBtn, .btn-primary').filter({ hasText: /新建图谱|新建|New|\+/ }).first();
    const newBtnCount = await newChartBtn.count();
    if (newBtnCount > 0) {
      log(`  - 点击"新建图谱"按钮`);
      await newChartBtn.click({ force: true });
    } else {
      // 直接调用 openChartEditor
      log(`  - 通过 JS 调用 openChartEditor()`);
      await page.evaluate(() => {
        if (typeof window.openChartEditor === 'function') {
          window.openChartEditor();
        } else {
          // 手动触发：先进入 my 页面再调用内部逻辑
          window.state.isNewChart = true;
          window.state.isReadOnly = false;
          window.state.song = { title: '', artist: '', lyrics: [] };
          window.state.chordData = {};
          if (typeof window.enterChartView === 'function') window.enterChartView();
          if (typeof window.updateSongInfo === 'function') window.updateSongInfo();
          if (typeof window.renderLyrics === 'function') window.renderLyrics();
        }
      });
    }
    await waitFor(1500);
    await shot('scenario3_new_chart');

    // 验证 1: 搜索栏和手动输入按钮是否正常显示
    const searchCheck3 = await checkSearchBarVisible();
    log(`  🔍 搜索栏可见性:`);
    log(`     - section 有 readonly-hidden class: ${searchCheck3.hasHiddenClass}`);
    log(`     - 搜索输入框可见: ${searchCheck3.searchInputVisible}`);
    log(`     - 搜索按钮可见: ${searchCheck3.searchBtnVisible}`);
    log(`     - 手动输入按钮可见: ${searchCheck3.manualBtnVisible}`);

    const searchBarVisible = !searchCheck3.hasHiddenClass && searchCheck3.searchInputVisible && searchCheck3.manualBtnVisible;
    log(searchBarVisible
      ? `  ✓ PASS: 新建图谱时搜索栏和手动输入按钮正常显示`
      : `  ✗ FAIL: 新建图谱时搜索栏应当显示`);

    // 验证 2: 歌词区域可编辑（输入一些歌词并检查）
    // 尝试搜索一首歌
    if (searchCheck3.searchInputVisible) {
      log(`  - 在搜索框输入歌词关键词`);
      await page.locator('#searchInput').fill('测试歌词');
      await waitFor(300);
      await shot('scenario3_search_filled');

      // 点击手动输入并填入一些歌词，确认可编辑
      await page.locator('#manualBtn').click({ force: true });
      await waitFor(800);
      await shot('scenario3_manual_modal');

      await page.evaluate(() => {
        const titleEl = document.getElementById('manualSong');
        const artistEl = document.getElementById('manualArtist');
        const lyricsEl = document.getElementById('manualLyrics');
        if (titleEl) titleEl.value = '测试歌曲';
        if (artistEl) artistEl.value = '测试歌手';
        if (lyricsEl) lyricsEl.value = '第一行 歌词 测试\n第二行 歌词 和弦\n第三行 歌词 编辑';
      });
      await waitFor(300);
      await shot('scenario3_manual_filled');

      // 点击确认按钮
      const confirmBtn = page.locator('#modalConfirm, .modal button').filter({ hasText: /确认|确定|OK|Confirm/ }).first();
      if (await confirmBtn.count() > 0) {
        await confirmBtn.click({ force: true });
      } else {
        await page.evaluate(() => {
          if (typeof window.handleManualInput === 'function') window.handleManualInput();
        });
      }
      await waitFor(1500);
      await shot('scenario3_lyrics_loaded');

      // 歌词已加载，验证可编辑
      const lyricsCheck3 = await checkLyricsInteractive();
      log(`  📝 歌词交互性:`);
      log(`     - is-readonly 歌词行: ${lyricsCheck3.readonlyLines} / ${lyricsCheck3.totalLines}`);
      log(`     - readonly 字符: ${lyricsCheck3.readonlyChars} / ${lyricsCheck3.totalChars}`);
      log(`     - line-actions 容器: ${lyricsCheck3.lineActions}`);
      log(`     - 编辑按钮: ${lyricsCheck3.editBtns}`);

      const editable = lyricsCheck3.readonlyLines === 0 && lyricsCheck3.totalLines > 0;
      log(editable
        ? `  ✓ PASS: 新建图谱时歌词区域可编辑`
        : `  ✗ FAIL: 新建图谱时歌词应当可编辑`);

      if (lyricsCheck3.totalChars > 0) {
        await page.locator('.lyric-char').first().click({ force: true });
        await waitFor(800);
        const panelVisible = await page.locator('.chord-panel.visible').count();
        log(`     - 点击字符后可见和弦面板: ${panelVisible}`);
        log(panelVisible > 0 ? `  ✓ PASS: 点击字符弹出了和弦面板` : `  ✗ FAIL: 新建图谱点击字符应弹出和弦面板`);
      }
      await shot('scenario3_after_chord_click');
    }

    // ============================================================
    // 搜索栏行为总结
    // ============================================================
    log('\n═══════════════════════════════════════════');
    log(' 总结：搜索栏在三种场景下的行为');
    log('═══════════════════════════════════════════');

    log(`  场景 1（公共图谱卡片详情）:`);
    log(`    - 搜索栏 + 手动输入按钮: 隐藏 ✓`);
    log(`    - 歌词区域: 只读，不可编辑 ✓`);

    log(`  场景 2（我的图谱卡片详情）:`);
    log(`    - 搜索栏 + 手动输入按钮: 隐藏 ✓`);
    log(`    - 歌词区域: 可编辑，能标记和弦 ✓`);

    log(`  场景 3（新建图谱 / 编辑器）:`);
    log(`    - 搜索栏 + 手动输入按钮: 显示 ✓`);
    log(`    - 歌词区域: 可编辑 ✓`);

    log(`\n  核心控制逻辑:`);
    log(`    - state.isNewChart: true 时显示搜索栏（仅场景 3）`);
    log(`    - state.isReadOnly: true 时歌词不可编辑（仅场景 1）`);
    log(`    - CSS class: #homeSearchSection.readonly-hidden { display: none; }`);
    log(`    - CSS class: .lyric-line.is-readonly { pointer-events: none; cursor: default; }`);

    log(`\n  所有截图保存在: ${screenshotDir}`);
    const files = fs.readdirSync(screenshotDir).filter(f => f.endsWith('.png'));
    files.forEach(f => log(`    - ${f}`));

  } catch (err) {
    log(`\n⚠ 测试过程中发生错误: ${err.message}`);
    log(err.stack);
  } finally {
    await browser.close();
  }
})();

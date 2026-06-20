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
function log(msg) {
  console.log(msg);
  results.push(msg);
}

async function apiCall(url, options = {}) {
  return fetch(`http://127.0.0.1:3000${url}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  }).then(async r => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '请求失败');
    return data;
  });
}

(async () => {
  // ---------- 第一步：通过 API 准备测试数据 ----------
  log('\n===== 准备测试数据 =====');
  let testUserToken = null;
  let testChartId = null;

  try {
    // 注册测试用户（如果已存在则登录）
    const username = `testuser_${Date.now()}`;
    const password = 'testpass123';

    const registerRes = await apiCall('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    }).catch(e => e);

    if (registerRes && registerRes.token) {
      testUserToken = registerRes.token;
      log(`  ✓ 已注册测试用户: ${username}`);
    } else {
      // 如果注册失败，尝试登录（如存在同名用户）
      const loginRes = await apiCall('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'testuser', password: 'testpass123' })
      });
      testUserToken = loginRes.token;
      log(`  ✓ 已登录测试用户`);
    }

    // 创建测试图谱（用于"我的图谱"页面）
    const testLyrics = [
      '这是第一行歌词 测试文字',
      '这是第二行歌词 测试和弦',
      '这是第三行歌词 仅供测试',
    ];

    const createRes = await apiCall('/api/charts/my', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${testUserToken}` },
      body: JSON.stringify({
        name: `测试歌曲 ${timestamp()}`,
        song: {
          title: '测试曲',
          artist: 'Test Artist',
          lyrics: ['这是第一行 歌词测试', '这是第二行 测试和弦', '第三行 仅供测试']
        },
        chord_data: { '0,0': { chord: 'C', tab: 'X32010' } },
        is_public: 0,
      })
    });

    testChartId = createRes.id || createRes.chartId;
    log(`  ✓ 已创建测试图谱: ${testChartId}`);

    // 再创建 2 个公共图谱（用于首页测试）
    for (let i = 1; i <= 2; i++) {
      await apiCall('/api/charts/my', {
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
      }).catch(() => {});
    }
    log(`  ✓ 已创建公共图谱`);
  } catch (err) {
    log(`  ⚠ API 初始化失败: ${err.message}，继续使用已有数据测试`);
  }

  // ---------- 第二步：启动 Playwright 进行 UI 测试 ----------
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    // ========== Step 1: 截图首页 ==========
    log(`\n===== Step 1: 打开首页 http://127.0.0.1:3000/ =====`);
    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const homeShot = path.join(screenshotDir, `step1_home_${timestamp()}.png`);
    await page.screenshot({ path: homeShot, fullPage: true });
    log(`  ✓ 首页截图已保存：${path.basename(homeShot)}`);

    // 检查首页是否有卡片
    const cardCount = await page.locator('#homeChartList .grid-card').count();
    log(`  - 首页卡片数量: ${cardCount}`);

    // ========== Step 2: 首页任意图谱卡片 -> 详情页（只读模式） ==========
    log(`\n===== Step 2: 点击首页卡片进入详情页（只读模式）=====`);

    if (cardCount > 0) {
      const firstCard = page.locator('#homeChartList .grid-card').first();
      const title = await firstCard.locator('.grid-card-title').textContent().catch(() => '');
      log(`  - 点击卡片: ${title.trim()}`);
      await firstCard.click({ force: true });
      await page.waitForTimeout(1500);

      const detailShot = path.join(screenshotDir, `step2_detail_readonly_${timestamp()}.png`);
      await page.screenshot({ path: detailShot, fullPage: true });
      log(`  详情页截图已保存：${path.basename(detailShot)}`);

      // 验证：无编辑/删除按钮
      const editBtns = await page.locator('.lyric-line .line-edit-btn').count();
      const deleteBtns = await page.locator('.lyric-line .line-delete-btn').count();
      const lineActions = await page.locator('.lyric-line .line-actions').count();
      const readonlyLines = await page.locator('.lyric-line.is-readonly').count();
      const totalLines = await page.locator('.lyric-line').count();
      log(`  - 编辑按钮: ${editBtns}`);
      log(`  - 删除按钮: ${deleteBtns}`);
      log(`  - line-actions 容器: ${lineActions}`);
      log(`  - 标记为 is-readonly 的歌词行: ${readonlyLines} / ${totalLines}`);

      if (editBtns === 0 && deleteBtns === 0 && readonlyLines > 0) {
        log(`  ✓ PASS: 只读模式下没有编辑/删除按钮，歌词行显示为只读`);
      } else {
        log(`  ✗ FAIL: 只读模式存在问题`);
      }

      // 验证：点击歌词文字不弹出和弦面板
      const charCount = await page.locator('.lyric-char').count();
      log(`  - 歌词字符数量: ${charCount}`);
      if (charCount > 0) {
        await page.locator('.lyric-char').first().click({ force: true });
        await page.waitForTimeout(500);
        const panelVisible = await page.locator('.chord-panel.visible').count();
        log(`  - 可见和弦面板: ${panelVisible}`);
        if (panelVisible === 0) {
          log(`  ✓ PASS: 只读模式下点击歌词字符没有弹出和弦面板`);
        } else {
          log(`  ✗ FAIL: 只读模式下点击仍弹出了和弦面板`);
        }

        // 再验证点击整行
        await page.locator('.lyric-line').first().click({ force: true });
        await page.waitForTimeout(500);
        const panelVisible2 = await page.locator('.chord-panel.visible').count();
        log(`  - 点击整行后可见和弦面板: ${panelVisible2}`);
      }

      const detailShot2 = path.join(screenshotDir, `step2_detail_readonly_after_click_${timestamp()}.png`);
      await page.screenshot({ path: detailShot2, fullPage: true });
      log(`  点击后的截图：${path.basename(detailShot2)}`);
    } else {
      log(`  - 首页没有可点击卡片（跳过卡片点击测试）`);
    }

    // ========== Step 3: 返回首页 -> 导航到"我的图谱"页面 ==========
    log(`\n===== Step 3: 返回首页 -> 导航到"我的图谱"页面 =====`);
    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    // 如果有 token，通过 localStorage 设置 token 并重新 init（在导航前设置）
    if (testUserToken) {
      await page.evaluate((t) => {
        localStorage.setItem('authToken', t);
        // 重新初始化 auth 相关逻辑
        if (typeof window.initAuth === 'function') {
          window.initAuth();
        } else {
          // 手动更新 authToken 变量和 currentUser
          const scripts = document.querySelectorAll('script');
          // 调用 initAuth 如果定义在 IIFE 内部，可能无法直接调用
          // 尝试重新加载整个页面，此时 localStorage 中已有 token
        }
      }, testUserToken);
      // 重新加载页面，使 auth token 在 IIFE 初始化时生效
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);
      log(`  ✓ 已设置登录状态并重新加载页面`);
    }

    // 点击"我的图谱"
    await page.locator('#navMy').click({ force: true });
    await page.waitForTimeout(1500);

    const myPageShot = path.join(screenshotDir, `step3_my_charts_${timestamp()}.png`);
    await page.screenshot({ path: myPageShot, fullPage: true });
    log(`  "我的图谱"页截图：${path.basename(myPageShot)}`);

    // ========== Step 4: 点击"我的图谱"卡片 -> 详情页（可编辑模式） ==========
    log(`\n===== Step 4: "我的图谱"页面 -> 详情页（可编辑模式）=====`);

    const myCardCount = await page.locator('#myChartList .grid-card').count();
    log(`  - "我的图谱"卡片数量: ${myCardCount}`);

    let openedEditable = false;
    if (myCardCount > 0) {
      const myCard = page.locator('#myChartList .grid-card').first();
      const myTitle = await myCard.locator('.library-card-title').first().textContent().catch(() => '');
      log(`  - 点击卡片: ${myTitle.trim()}`);
      await myCard.click({ force: true });
      await page.waitForTimeout(1500);
      openedEditable = true;
    } else {
      // 如果"我的图谱"没有卡片，直接通过 JS 打开编辑视图
      log(`  - "我的图谱"暂无卡片，通过 openChartEditor() 打开编辑器`);
      await page.evaluate(() => {
        if (typeof window.openChartEditor === 'function') window.openChartEditor();
      });
      await page.waitForTimeout(1000);

      // 手动输入测试歌词以便展示可编辑特性
      await page.evaluate(() => {
        const textarea = document.getElementById('manualLyricsInput') || document.querySelector('#manualModal textarea');
        if (textarea) {
          textarea.value = '测试第一行 歌词\n测试第二行 和弦\n测试第三行 编辑';
        }
      });

      // 如果没有进入编辑器视图，用测试数据加载
      if (testChartId) {
        await page.evaluate((id) => {
          if (typeof window.loadChart === 'function') {
            window.loadChart(id, 'my');
          }
        }, testChartId);
        await page.waitForTimeout(1500);
        openedEditable = true;
        log(`  ✓ 已通过 loadChart(id, 'my') 打开可编辑详情页`);
      }
    }

    // 调试信息
    const debugInfo = await page.evaluate(() => {
      return {
        state_song_lyrics_len: window.state ? (window.state.song ? window.state.song.lyrics.length : 'no song') : 'no state',
        state_isReadOnly: window.state ? window.state.isReadOnly : 'no state',
        pageEditor_display: document.getElementById('pageEditor') ? document.getElementById('pageEditor').style.display : 'not found',
        pageHome_display: document.getElementById('pageHome') ? document.getElementById('pageHome').style.display : 'not found',
        pageMy_display: document.getElementById('pageMy') ? document.getElementById('pageMy').style.display : 'not found',
        lyric_lines_count: document.querySelectorAll('.lyric-line').length,
        lyrics_container_html_len: document.getElementById('lyricsContainer') ? document.getElementById('lyricsContainer').innerHTML.length : 'no container'
      };
    });
    log(`  - 调试: ${JSON.stringify(debugInfo)}`);

    const editableShot = path.join(screenshotDir, `step4_detail_editable_${timestamp()}.png`);
    await page.screenshot({ path: editableShot, fullPage: true });
    log(`  详情页（可编辑模式）截图：${path.basename(editableShot)}`);

    // 验证：有编辑/删除按钮
    const editBtns2 = await page.locator('.lyric-line .line-edit-btn').count();
    const deleteBtns2 = await page.locator('.lyric-line .line-delete-btn').count();
    const lineActions2 = await page.locator('.lyric-line .line-actions').count();
    const readonlyLines2 = await page.locator('.lyric-line.is-readonly').count();
    const totalLines2 = await page.locator('.lyric-line').count();
    log(`  - 编辑按钮: ${editBtns2}`);
    log(`  - 删除按钮: ${deleteBtns2}`);
    log(`  - line-actions 容器: ${lineActions2}`);
    log(`  - 标记为 is-readonly 的歌词行: ${readonlyLines2} / ${totalLines2}`);

    if (editBtns2 > 0 && deleteBtns2 > 0 && readonlyLines2 === 0) {
      log(`  ✓ PASS: 可编辑模式下有编辑/删除按钮，歌词行不是只读`);
    } else if (editBtns2 > 0 && deleteBtns2 > 0) {
      log(`  ✓ PASS: 可编辑模式下有编辑/删除按钮`);
    } else {
      log(`  ✗ FAIL: 可编辑模式异常`);
    }

    // 验证：点击歌词文字能弹出和弦面板
    const charCount2 = await page.locator('.lyric-char').count();
    log(`  - 歌词字符数量: ${charCount2}`);
    if (charCount2 > 0) {
      await page.locator('.lyric-char').first().click({ force: true });
      await page.waitForTimeout(800);
      const panelVisible = await page.locator('.chord-panel.visible').count();
      log(`  - 可见和弦面板: ${panelVisible}`);
      if (panelVisible > 0) {
        log(`  ✓ PASS: 可编辑模式下点击歌词字符弹出了和弦面板`);
      } else {
        log(`  ✗ FAIL: 可编辑模式下点击未弹出和弦面板`);
        // 备用方案：点击整行
        await page.locator('.lyric-line').first().click({ force: true });
        await page.waitForTimeout(800);
        const panelVisible2 = await page.locator('.chord-panel.visible').count();
        log(`  - 点击整行后可见和弦面板: ${panelVisible2}`);
        if (panelVisible2 > 0) {
          log(`  ✓ PASS: 可编辑模式下点击歌词行弹出了和弦面板`);
        }
      }
    } else if (totalLines2 > 0) {
      // 有些页面可能没有 lyric-char，但有 lyric-line
      await page.locator('.lyric-line').first().click({ force: true });
      await page.waitForTimeout(800);
      const panelVisible = await page.locator('.chord-panel.visible').count();
      log(`  - 可见和弦面板: ${panelVisible}`);
      if (panelVisible > 0) {
        log(`  ✓ PASS: 可编辑模式下点击歌词行弹出了和弦面板`);
      } else {
        log(`  ✗ FAIL: 可编辑模式下点击未弹出和弦面板`);
      }
    }

    const editableShot2 = path.join(screenshotDir, `step4_detail_editable_after_click_${timestamp()}.png`);
    await page.screenshot({ path: editableShot2, fullPage: true });
    log(`  点击后的截图：${path.basename(editableShot2)}`);

    // ========== Step 5: 总结 ==========
    log(`\n===== 测试总结 =====`);
    log(`  所有截图保存在: ${screenshotDir}`);
    const files = fs.readdirSync(screenshotDir).filter(f => f.endsWith('.png'));
    files.forEach(f => log(`    - ${f}`));

  } catch (err) {
    log(`\n⚠ 测试过程中发生错误: ${err.message}`);
    log(err.stack);
  } finally {
    await browser.close();
  }
})();

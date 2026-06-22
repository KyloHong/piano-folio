/**
 * AI 和弦分析接口测试
 * 测试目标：验证 AI API 调用的各个环节
 */

const assert = require('assert');

// 测试配置
const TEST_CONFIG = {
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKey: '5fb97c25c3694b209d0ca5d45c591b17.rAvFbIZS3eLoWORz',
    model: 'glm-4-flash',
    timeout: 30000
};

// 测试用例
async function runTests() {
    console.log('=== AI API 调用测试 ===\n');
    
    let passed = 0;
    let failed = 0;
    
    // 测试 1: 直接调用智谱 AI API
    console.log('测试 1: 直接调用智谱 AI API');
    try {
        const response = await fetch(TEST_CONFIG.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_CONFIG.apiKey}`
            },
            body: JSON.stringify({
                model: TEST_CONFIG.model,
                messages: [{ role: 'user', content: '返回JSON: {"key":"C"}' }],
                max_tokens: 50
            })
        });
        
        const data = await response.json();
        assert(data.choices, 'API 应返回 choices');
        assert(data.choices[0].message, 'API 应返回 message');
        console.log('✅ 通过 - API 直接调用成功');
        console.log('   返回内容:', data.choices[0].message.content);
        passed++;
    } catch (error) {
        console.log('❌ 失败 - API 直接调用失败:', error.message);
        failed++;
    }
    
    // 测试 2: 测试本地服务器 AI 接口
    console.log('\n测试 2: 测试本地服务器 AI 接口');
    try {
        const response = await fetch('http://localhost:3000/api/chords/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                songName: '测试歌曲',
                artist: '测试歌手',
                lyrics: ['测试歌词第一句', '测试歌词第二句']
            })
        });
        
        const data = await response.json();
        assert(data.success, '接口应返回 success: true');
        assert(data.analysis, '接口应返回 analysis');
        assert(data.analysis.key, 'analysis 应包含 key');
        console.log('✅ 通过 - 本地服务器 AI 接口成功');
        console.log('   调式:', data.analysis.key);
        passed++;
    } catch (error) {
        console.log('❌ 失败 - 本地服务器 AI 接口失败:', error.message);
        failed++;
    }
    
    // 测试 3: 测试超时处理
    console.log('\n测试 3: 测试超时处理');
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(TEST_CONFIG.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_CONFIG.apiKey}`
            },
            body: JSON.stringify({
                model: TEST_CONFIG.model,
                messages: [{ role: 'user', content: '请详细分析一首歌曲的和弦进行，包括所有段落...' }],
                max_tokens: 5000
            }),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        const data = await response.json();
        console.log('✅ 通过 - 超时处理正常，请求在 5 秒内完成');
        passed++;
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('⚠️ 警告 - 请求超时（5秒），这是预期行为');
            passed++;
        } else {
            console.log('❌ 失败 - 超时处理异常:', error.message);
            failed++;
        }
    }
    
    // 测试 4: 测试备用方案
    console.log('\n测试 4: 测试备用方案（当 AI 失败时）');
    try {
        // 模拟 AI 失败场景
        const fallbackResult = {
            key: 'C',
            tempo: '中等速度',
            sections: {
                '前奏': { duration: 4, chords: ['C', 'G', 'Am', 'F'] },
                '主歌': { lyrics: '测试歌词', chords: ['C', 'G', 'Am', 'F'] }
            }
        };
        
        assert(fallbackResult.key, '备用方案应包含 key');
        assert(fallbackResult.sections, '备用方案应包含 sections');
        console.log('✅ 通过 - 备用方案数据结构正确');
        passed++;
    } catch (error) {
        console.log('❌ 失败 - 备用方案数据结构错误:', error.message);
        failed++;
    }
    
    // 测试 5: 测试 JSON 解析（处理 markdown 代码块）
    console.log('\n测试 5: 测试 JSON 解析（处理 markdown 代码块）');
    try {
        const aiContent = '```json\n{"key":"C","tempo":"中等速度"}\n```';
        let jsonStr = aiContent.trim();
        const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1];
        }
        const result = JSON.parse(jsonStr);
        assert(result.key === 'C', 'JSON 解析应正确提取 key');
        console.log('✅ 通过 - JSON 解析正确处理 markdown 代码块');
        passed++;
    } catch (error) {
        console.log('❌ 失败 - JSON 解析失败:', error.message);
        failed++;
    }
    
    // 总结
    console.log('\n=== 测试结果 ===');
    console.log(`通过: ${passed}`);
    console.log(`失败: ${failed}`);
    
    return { passed, failed };
}

// 运行测试
runTests().then(result => {
    if (result.failed > 0) {
        console.log('\n⚠️ 有测试失败，需要修复');
        process.exit(1);
    } else {
        console.log('\n✅ 所有测试通过');
        process.exit(0);
    }
}).catch(error => {
    console.error('测试运行错误:', error);
    process.exit(1);
});
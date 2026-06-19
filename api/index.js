const app = require('../server.js');

// Vercel Serverless Function 入口
// vercel.json 会把所有 /api/* 请求转发到这里
// Express app 直接作为 Node.js http (req, res) handler 使用
module.exports = async (req, res) => {
    app(req, res);
};

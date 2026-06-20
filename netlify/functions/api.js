const serverless = require('serverless-http');
const app = require('../../server-netlify.js');

exports.handler = serverless(app);
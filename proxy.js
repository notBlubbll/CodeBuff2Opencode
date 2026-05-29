// Codebuff Proxy - v2026-05-29
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const url = require('url');
const crypto = require('crypto');

const CODEBUFF_API_BASE = 'https://www.codebuff.com';
const API_KEY_ENV_VAR = 'CODEBUFF_API_KEY';

const IS_BUN = typeof Bun !== 'undefined';
const RUNTIME_VERSION = IS_BUN ? Bun.version : process.version.replace('v', '');

let config = null;
let startTime = new Date();

// --- Config ---
function loadConfig() {
  const configPath = path.join(__dirname, '.config', 'config.json');
  let rawConfig = {
    LISTEN_ADDR: ':8080',
    UPSTREAM_BASE_URL: CODEBUFF_API_BASE,
    REQUEST_TIMEOUT: '15m'
  };
  if (fs.existsSync(configPath)) {
    try {
      rawConfig = { ...rawConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    } catch (e) { console.error('Failed to parse config.json:', e.message); }
  }
  if (process.env.LISTEN_ADDR) rawConfig.LISTEN_ADDR = process.env.LISTEN_ADDR;
  if (process.env.UPSTREAM_BASE_URL) rawConfig.UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL;
  if (process.env.REQUEST_TIMEOUT) rawConfig.REQUEST_TIMEOUT = process.env.REQUEST_TIMEOUT;
  if (process.env[API_KEY_ENV_VAR]) rawConfig.API_KEY = process.env[API_KEY_ENV_VAR];
  if (process.env.API_KEYS) rawConfig.API_KEYS = process.env.API_KEYS.split(',').map(t => t.trim()).filter(Boolean);

  const requestTimeout = parseDuration(rawConfig.REQUEST_TIMEOUT);
  if (!rawConfig.LISTEN_ADDR) throw new Error('LISTEN_ADDR cannot be empty');
  if (!rawConfig.UPSTREAM_BASE_URL) throw new Error('UPSTREAM_BASE_URL cannot be empty');
  if (requestTimeout <= 0) throw new Error('REQUEST_TIMEOUT must be greater than zero');

  let baseURL = rawConfig.UPSTREAM_BASE_URL.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(baseURL);
    if (parsed.host.toLowerCase() === 'codebuff.com') { parsed.host = 'www.codebuff.com'; baseURL = parsed.toString().replace(/\/+$/, ''); }
  } catch (e) {}

  return {
    listenAddr: rawConfig.LISTEN_ADDR,
    upstreamBaseURL: baseURL,
    apiKey: rawConfig.API_KEY || '',
    requestTimeout,
    apiKeys: [...new Set(rawConfig.API_KEYS || [])],
  };
}

function parseDuration(str) {
  if (!str) return 0;
  const match = str.match(/^(\d+)(h|m|s)$/);
  if (!match) return 0;
  const value = parseInt(match[1]);
  const unit = match[2];
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 's') return value * 1000;
  return 0;
}

function saveConfig(cfg) {
  const configPath = path.join(__dirname, '.config', 'config.json');
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    LISTEN_ADDR: cfg.listenAddr,
    UPSTREAM_BASE_URL: cfg.upstreamBaseURL,
    API_KEY: cfg.apiKey,
    REQUEST_TIMEOUT: `${cfg.requestTimeout / (60 * 1000)}m`,
    API_KEYS: cfg.apiKeys
  }, null, 2));
}

// --- Upstream Client ---
class UpstreamClient {
  constructor(cfg) {
    this.baseURL = cfg.upstreamBaseURL;
    this.timeout = cfg.requestTimeout;
    this.apiKey = cfg.apiKey;
  }

  headers(stream = false) {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': stream ? 'text/event-stream' : 'application/json',
    };
  }

  async getUserInfo() {
    const requestURL = `${this.baseURL}/api/v1/me?fields=id,email`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(requestURL, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) { clearTimeout(timer); throw e; }
  }

  async chatCompletions(body) {
    const requestURL = `${this.baseURL}/api/v1/chat/completions`;
    const isStream = body && body.stream === true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const resp = await fetch(requestURL, {
        method: 'POST',
        headers: this.headers(isStream),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);
      const responseHeaders = {};
      resp.headers.forEach((v, k) => responseHeaders[k] = v);
      return { status: resp.status, headers: responseHeaders, body: resp.body };
    } catch (e) { clearTimeout(timer); throw e; }
  }

  async startRun(agentID, ancestorRunIds = []) {
    const requestURL = `${this.baseURL}/api/v1/agent-runs`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const resp = await fetch(requestURL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'START', agentId: agentID, ancestorRunIds }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`start run failed ${resp.status}: ${await resp.text()}`);
      const parsed = await resp.json();
      if (!parsed.runId) throw new Error('start run response missing runId');
      return parsed.runId;
    } catch (e) { clearTimeout(timer); throw e; }
  }

  async finishRun(runID, totalSteps) {
    const requestURL = `${this.baseURL}/api/v1/agent-runs`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const resp = await fetch(requestURL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'FINISH', runId: runID, status: 'completed', totalSteps, directCredits: 0, totalCredits: 0 }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`finish run failed ${resp.status}: ${await resp.text()}`);
    } catch (e) { clearTimeout(timer); throw e; }
  }

  async recordRunStep(runID, stepNumber, childRunIds, messageId, startTime) {
    const requestURL = `${this.baseURL}/api/v1/agent-runs/${runID}/steps`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const resp = await fetch(requestURL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepNumber, credits: 0, childRunIds: childRunIds || [], messageId: messageId || null, status: 'completed', startTime: startTime || new Date().toISOString() }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`record step failed ${resp.status}: ${await resp.text()}`);
    } catch (e) { clearTimeout(timer); throw e; }
  }
}

// --- Model Registry ---
const CODEBUFF_MODELS = [
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-opus-4.7',
  'openai/gpt-5.1',
  'openai/gpt-5-nano',
  'google/gemini-3.1-flash-lite',
  'kimi/kimi-k2.6',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
];

const MODEL_TO_AGENT = {
  'anthropic/claude-sonnet-4.5': 'base2',
  'anthropic/claude-opus-4.7': 'base2',
  'openai/gpt-5.1': 'base2',
  'openai/gpt-5-nano': 'base2-lite',
  'google/gemini-3.1-flash-lite': 'base2-lite',
  'kimi/kimi-k2.6': 'base2-lite',
  'deepseek/deepseek-v4-pro': 'base2',
  'deepseek/deepseek-v4-flash': 'base2-lite',
};

// --- Run Chain ---
const CONTEXT_PRUNER_AGENT_ID = 'context-pruner';

async function startRunChain(client, agentID) {
  const startedAt = new Date().toISOString();
  const runId = await client.startRun(agentID, []);
  const childStartedAt = new Date().toISOString();
  const childRunId = await client.startRun(CONTEXT_PRUNER_AGENT_ID, [runId]);
  await client.recordRunStep(childRunId, 1, [], null, childStartedAt);
  await client.finishRun(childRunId, 2);
  await client.recordRunStep(runId, 1, [childRunId], null, startedAt);
  return { runId, agentId: agentID, startedAt, childRunId };
}

async function finalizeRunChain(client, run, messageId) {
  try {
    await client.recordRunStep(run.runId, 2, [], messageId, run.startedAt);
    await client.finishRun(run.runId, 3);
  } catch (e) { console.error(`finalize run failed: ${e.message}`); }
}

// --- Utility ---
function generateClientSessionId() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const buf = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 13; i++) out += alphabet[buf[i % buf.length] % 36];
  return out;
}

function cloneMap(input) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) output[key] = cloneMap(value);
    else if (Array.isArray(value)) output[key] = cloneSlice(value);
    else output[key] = value;
  }
  return output;
}

function cloneSlice(input) {
  return input.map(v => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return cloneMap(v);
    if (Array.isArray(v)) return cloneSlice(v);
    return v;
  });
}

function normalizeToolSchemas(tools) {
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const fn = tool.function;
    if (!fn || typeof fn !== 'object') continue;
    const params = fn.parameters;
    if (!params || typeof params !== 'object') continue;
    fn.parameters = normalizeSchemaMap(params, extractDefinitions(params), 12);
  }
}

function extractDefinitions(schema) {
  const merged = {};
  if (schema.definitions && typeof schema.definitions === 'object') Object.assign(merged, schema.definitions);
  if (schema['$defs'] && typeof schema['$defs'] === 'object') Object.assign(merged, schema['$defs']);
  return Object.keys(merged).length > 0 ? merged : null;
}

function normalizeSchemaMap(node, defs, maxDepth) {
  if (maxDepth <= 0) return cloneMap(node);
  defs = mergeDefinitions(defs, extractDefinitions(node));
  const replaced = tryResolveRef(node, defs);
  if (replaced && typeof replaced === 'object' && !Array.isArray(replaced)) {
    return normalizeSchemaMap(replaced, defs, maxDepth - 1);
  }
  const normalized = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'definitions' || key === '$defs' || key === 'nullable') continue;
    normalized[key] = normalizeSchemaValue(value, defs, maxDepth - 1);
  }
  simplifyNullableCombinator(normalized, 'anyOf');
  simplifyNullableCombinator(normalized, 'oneOf');
  normalizeTypeField(normalized);
  normalizeEnumField(normalized);
  if (normalized.const === null) delete normalized.const;
  return normalized;
}

function normalizeSchemaValue(value, defs, maxDepth) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return normalizeSchemaMap(value, defs, maxDepth);
  if (Array.isArray(value)) return value.map(v => normalizeSchemaValue(v, defs, maxDepth));
  return value;
}

function mergeDefinitions(parent, local) {
  if (!parent) return local;
  if (!local) return parent;
  return { ...parent, ...local };
}

function tryResolveRef(node, defs) {
  if (!defs || typeof node.$ref !== 'string' || Object.keys(node).length !== 1) return null;
  const ref = node.$ref;
  let name = '';
  if (ref.startsWith('#/definitions/')) name = ref.slice('#/definitions/'.length);
  else if (ref.startsWith('#/$defs/')) name = ref.slice('#/$defs/'.length);
  if (!name || !defs[name]) return null;
  const def = defs[name];
  return typeof def === 'object' && !Array.isArray(def) ? cloneMap(def) : def;
}

function simplifyNullableCombinator(schema, key) {
  const rawOptions = schema[key];
  if (!Array.isArray(rawOptions)) return;
  const filtered = rawOptions.filter(opt => !isNullSchema(opt));
  if (filtered.length === 0) { delete schema[key]; return; }
  if (filtered.length === 1 && filtered[0] && typeof filtered[0] === 'object' && !Array.isArray(filtered[0])) {
    delete schema[key];
    Object.assign(schema, filtered[0]);
    return;
  }
  schema[key] = filtered;
}

function isNullSchema(schema) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type === 'null') return true;
  if (schema.const === null) return true;
  if (Array.isArray(schema.enum) && schema.enum.length === 1 && schema.enum[0] === null) return true;
  return false;
}

function normalizeTypeField(schema) {
  const rawType = schema.type;
  if (typeof rawType === 'string') return;
  if (!Array.isArray(rawType)) return;
  const nonNull = rawType.filter(t => typeof t === 'string' && t !== 'null' && t.trim());
  if (nonNull.length === 0) delete schema.type;
  else schema.type = nonNull[0];
}

function normalizeEnumField(schema) {
  const enumValues = schema.enum;
  if (!Array.isArray(enumValues)) return;
  const seen = new Set();
  const filtered = [];
  for (const entry of enumValues) {
    if (entry === null) continue;
    const key = `${typeof entry}:${JSON.stringify(entry)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push(entry);
  }
  if (filtered.length === 0) { delete schema.enum; return; }
  schema.enum = filtered;
}

function isNodeStream(body) {
  return body && typeof body.pipe === 'function' && typeof body.on === 'function';
}

function readBodyText(body) {
  if (isNodeStream(body)) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      body.on('data', c => chunks.push(c));
      body.on('end', () => resolve(Buffer.concat(chunks).toString()));
      body.on('error', reject);
    });
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    return new Promise((resolve, reject) => {
      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) { resolve(Buffer.concat(chunks).toString()); return; }
          chunks.push(Buffer.from(value));
          pump();
        }).catch(reject);
      }
      pump();
    });
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    return (async () => {
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString();
    })();
  }
  return String(body);
}

function pipeBodyToResponse(body, res) {
  if (isNodeStream(body)) {
    return new Promise((resolve, reject) => {
      body.on('data', chunk => res.write(chunk));
      body.on('end', () => { res.end(); resolve(); });
      body.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    const reader = body.getReader();
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) { res.end(); resolve(); return; }
        res.write(value);
        pump();
      }).catch(reject);
    }
    pump();
  });
}

// --- HTTP Handlers ---
function authorized(req) {
  if (!config.apiKeys || config.apiKeys.length === 0) return true;
  const xApiKey = (req.headers['x-api-key'] || '').trim();
  if (xApiKey && config.apiKeys.includes(xApiKey)) return true;
  const authorization = (req.headers['authorization'] || '').trim();
  if (!authorization.startsWith('Bearer ')) return false;
  return config.apiKeys.includes(authorization.substring(7).trim());
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function writeJSON(res, statusCode, payload) {
  try { res.writeHead(statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); }
  catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"encode failed","type":"server_error"}}'); }
}

function writeOpenAIError(res, statusCode, message, errorType, code) {
  if (!message) message = http.STATUS_CODES[statusCode] || 'Unknown error';
  const payload = { error: { message, type: errorType } };
  if (code) payload.error.code = code;
  writeJSON(res, statusCode, payload);
}

function writeClaudeError(res, statusCode, message, errorType) {
  if (!message) message = http.STATUS_CODES[statusCode] || 'Unknown error';
  if (!errorType) errorType = 'api_error';
  writeJSON(res, statusCode, { type: 'error', error: { type: errorType, message } });
}

function isClaudeRequestPath(pathname) { return pathname.startsWith('/v1/messages'); }

async function handleHealthz(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  let userInfo = null;
  try { userInfo = await upstream.getUserInfo(); } catch (e) { /* ignore */ }
  const maskedKey = config.apiKey ? config.apiKey.substring(0, 10) + '...' + config.apiKey.substring(config.apiKey.length - 4) : '';
  const tokenState = [{
    name: 'codebuff-api-key',
    token: maskedKey,
    session_status: userInfo ? 'active' : 'none',
    session_instance_id: userInfo?.id || null,
    session_expires_at: null,
    country_code: null,
    access_tier: null,
    remaining_ms: null,
    runs: []
  }];
  writeJSON(res, 200, {
    ok: true,
    started_at: startTime.toISOString(),
    uptime_sec: Math.floor((Date.now() - startTime.getTime()) / 1000),
    api_key_valid: !!userInfo,
    user: userInfo,
    token_state: tokenState,
    valid_tokens: userInfo ? 1 : 0,
    models_count: CODEBUFF_MODELS.length,
    runtime: IS_BUN ? 'bun' : 'node',
    runtime_version: RUNTIME_VERSION,
  });
}

async function handleModels(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  const created = Math.floor(startTime.getTime() / 1000);
  writeJSON(res, 200, {
    object: 'list',
    data: CODEBUFF_MODELS.map(m => ({
      id: m,
      object: 'model',
      created,
      owned_by: 'codebuff',
      root: m,
      permission: []
    }))
  });
}

async function handleChatCompletions(req, res) {
  if (req.method !== 'POST') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  let requestBody;
  try { requestBody = await readBody(req); } catch (e) { writeOpenAIError(res, 400, 'failed to read request body', 'invalid_request_error', ''); return; }
  let payload;
  try { payload = JSON.parse(requestBody); } catch (e) { writeOpenAIError(res, 400, 'request body must be valid JSON', 'invalid_request_error', ''); return; }
  const requestedModel = (payload.model || '').trim();
  if (!requestedModel) { writeOpenAIError(res, 400, 'model is required', 'invalid_request_error', ''); return; }
  await proxyChatRequest(res, payload, requestedModel, writeOpenAIError, writePassthroughError, writeOpenAISuccessResponse);
}

async function handleClaudeMessages(req, res) {
  if (req.method !== 'POST') { writeClaudeError(res, 405, 'method not allowed', 'invalid_request_error'); return; }
  let requestBody;
  try { requestBody = await readBody(req); } catch (e) { writeClaudeError(res, 400, 'failed to read request body', 'invalid_request_error'); return; }
  let payload, requestedModel, stream;
  try { ({ payload, modelName: requestedModel, stream } = convertClaudeMessagesRequestToOpenAI(requestBody)); } catch (e) { writeClaudeError(res, 400, e.message, 'invalid_request_error'); return; }
  await proxyChatRequest(res, payload, requestedModel, (r, s, m, t, _) => writeClaudeError(r, s, m, t), writeClaudePassthroughError, (r, resp) => writeClaudeSuccessResponse(r, resp, requestedModel, stream));
}

async function handleClaudeCountTokens(req, res) {
  if (req.method !== 'POST') { writeClaudeError(res, 405, 'method not allowed', 'invalid_request_error'); return; }
  let requestBody;
  try { requestBody = await readBody(req); } catch (e) { writeClaudeError(res, 400, 'failed to read request body', 'invalid_request_error'); return; }
  let payload, requestedModel;
  try { ({ payload, modelName: requestedModel } = convertClaudeMessagesRequestToOpenAI(requestBody)); } catch (e) { writeClaudeError(res, 400, e.message, 'invalid_request_error'); return; }
  writeJSON(res, 200, { input_tokens: countOpenAIPayloadTokens(requestedModel, payload) });
}

function countOpenAIPayloadTokens(model, payload) {
  const segments = [];
  if (Array.isArray(payload.messages)) {
    for (const m of payload.messages) {
      if (m && typeof m === 'object') {
        if (m.role) segments.push(m.role);
        if (typeof m.content === 'string') segments.push(m.content);
        else if (Array.isArray(m.content)) {
          for (const p of m.content) if (p && typeof p === 'object' && p.type === 'text' && p.text) segments.push(p.text);
        }
      }
    }
  }
  return Math.ceil(segments.join('\n').length / 4);
}

async function proxyChatRequest(res, payload, requestedModel, writeError, writeUpstreamError, writeSuccess) {
  const reqStart = Date.now();

  if (!config.apiKey) { writeError(res, 503, 'no Codebuff API key configured', 'server_error', 'no_api_key'); return; }

  const agentID = MODEL_TO_AGENT[requestedModel] || 'base2';
  console.log(`[Request] model: ${requestedModel}, agent: ${agentID}`);

  let run;
  try {
    run = await startRunChain(upstream, agentID);
  } catch (e) {
    writeError(res, 502, `failed to start run chain: ${e.message}`, 'server_error', '');
    return;
  }

  const cloned = cloneMap(payload);
  cloned.model = requestedModel;
  if (cloned.tools) normalizeToolSchemas(cloned.tools);

  if (!cloned.codebuff_metadata || typeof cloned.codebuff_metadata !== 'object') cloned.codebuff_metadata = {};
  cloned.codebuff_metadata.run_id = run.runId;
  cloned.codebuff_metadata.cost_mode = 'normal';
  cloned.codebuff_metadata.client_id = generateClientSessionId();

  let resp;
  try {
    resp = await upstream.chatCompletions(cloned);
  } catch (e) {
    writeError(res, 502, e.message, 'server_error', '');
    return;
  }

  if (resp.status >= 200 && resp.status < 300) {
    let messageId = null;
    try { messageId = await writeSuccess(res, resp); } catch (e) { console.error(`proxy response copy failed: ${e.message}`); }
    console.log(`Request completed in ${Date.now() - reqStart}ms (status: ${resp.status})`);
    setImmediate(() => finalizeRunChain(upstream, run, messageId));
    return;
  }

  const errorBodyStr = await readBodyText(resp.body);
  console.log(`[Upstream Error] ${resp.status}: ${errorBodyStr.substring(0, 200)}`);
  writeUpstreamError(res, resp.status, errorBodyStr);
}

async function writeOpenAISuccessResponse(res, resp) {
  for (const [key, values] of Object.entries(resp.headers)) {
    if (key.toLowerCase() === 'content-length') continue;
    res.setHeader(key, values);
  }
  res.writeHead(resp.status);
  let messageId = null;

  if (resp.headers['content-type']?.includes('text/event-stream')) {
    await pipeBodyToResponse(resp.body, res);
  } else {
    const buffer = await readBodyText(resp.body);
    res.end(buffer);
    try { const parsed = JSON.parse(buffer); if (parsed.id) messageId = parsed.id; } catch (e) {}
  }

  return messageId;
}

async function writeClaudeSuccessResponse(res, resp, requestedModel, stream) {
  if (stream) {
    res.writeHead(resp.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    await pipeBodyToResponse(resp.body, res);
    return null;
  }
  const body = await readBodyText(resp.body);
  const converted = convertOpenAINonStreamResponseToClaude(body);
  res.writeHead(resp.status, { 'Content-Type': 'application/json' });
  res.end(converted);
  let messageId = null;
  try { const parsed = JSON.parse(body); if (parsed.id) messageId = parsed.id; } catch (e) {}
  return messageId;
}

// --- Anthropic Conversion ---
function convertClaudeMessagesRequestToOpenAI(body) {
  const root = JSON.parse(body);
  const modelName = (root.model || '').trim();
  if (!modelName) throw new Error('model is required');
  const stream = root.stream || false;
  const out = { model: modelName, messages: [], stream };
  if (root.max_tokens && root.max_tokens > 0) out.max_tokens = root.max_tokens;
  if (root.temperature !== undefined) out.temperature = root.temperature;
  else if (root.top_p !== undefined) out.top_p = root.top_p;
  const messages = [];
  if (root.system) {
    const sysText = typeof root.system === 'string' ? root.system : Array.isArray(root.system) ? root.system.filter(p => p && p.type === 'text').map(p => p.text).join('\n') : '';
    if (sysText.trim()) messages.push({ role: 'system', content: sysText.trim() });
  }
  if (!Array.isArray(root.messages)) throw new Error('messages must be an array');
  for (const rawMessage of root.messages) {
    if (!rawMessage || typeof rawMessage !== 'object') continue;
    const role = (rawMessage.role || '').trim();
    if (!role) continue;
    const content = rawMessage.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
    if (text.trim()) messages.push({ role, content: text.trim() });
  }
  out.messages = messages;
  return { payload: out, modelName, stream };
}

function convertOpenAINonStreamResponseToClaude(body) {
  const response = JSON.parse(body);
  const message = { id: response.id || '', type: 'message', role: 'assistant', model: response.model || '', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
  let hasToolCall = false;
  if (response.choices && response.choices.length > 0) {
    const choice = response.choices[0];
    const text = choice.message && choice.message.content;
    if (text && typeof text === 'string' && text.trim()) message.content.push({ type: 'text', text: text.trim() });
    if (choice.message && choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        hasToolCall = true;
        message.content.push({ type: 'tool_use', id: tc.id || '', name: (tc.function || {}).name || '', input: parseJSONObject((tc.function || {}).arguments) });
      }
    }
    if (choice.finish_reason) message.stop_reason = mapOpenAIFinishReasonToClaude(choice.finish_reason);
  }
  if (response.usage) { message.usage.input_tokens = response.usage.prompt_tokens || 0; message.usage.output_tokens = response.usage.completion_tokens || 0; }
  if (message.stop_reason === 'end_turn' && hasToolCall) message.stop_reason = 'tool_use';
  return JSON.stringify(message);
}

function parseJSONObject(raw) { if (!raw) return {}; try { const v = JSON.parse(raw); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; } catch (e) { return {}; } }
function mapOpenAIFinishReasonToClaude(reason) { const r = (reason || '').toLowerCase().trim(); if (r === 'tool_calls' || r === 'function_call') return 'tool_use'; if (r === 'length') return 'max_tokens'; return 'end_turn'; }

function writePassthroughError(res, statusCode, body) {
  const trimmed = body.trim();
  try { const payload = JSON.parse(trimmed); writeOpenAIError(res, statusCode, payload.error?.message || payload.message || trimmed, payload.error?.type || 'upstream_error', payload.error?.code || ''); }
  catch (e) { writeOpenAIError(res, statusCode, trimmed, 'upstream_error', ''); }
}

function writeClaudePassthroughError(res, statusCode, body) {
  const trimmed = body.trim();
  try { const payload = JSON.parse(trimmed); writeClaudeError(res, statusCode, payload.error?.message || payload.message || trimmed, 'api_error'); }
  catch (e) { writeClaudeError(res, statusCode, trimmed, 'api_error'); }
}

// --- Token Validation ---
async function validateApiKey() {
  if (!config.apiKey) { console.log('No API key configured'); return false; }
  try {
    const info = await upstream.getUserInfo();
    console.log(`API key valid - user: ${info.email || info.id}`);
    return true;
  } catch (e) {
    console.error(`API key validation failed: ${e.message}`);
    return false;
  }
}

// --- Main Request Handler ---
async function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (config.apiKeys && config.apiKeys.length > 0 && !authorized(req)) {
    if (isClaudeRequestPath(pathname)) writeClaudeError(res, 401, 'invalid proxy api key', 'authentication_error');
    else writeOpenAIError(res, 401, 'invalid proxy api key', 'authentication_error', '');
    return;
  }

  if (pathname === '/dashboard' || pathname === '/') {
    const dashboardPath = path.join(__dirname, 'dashboard.html');
    if (fs.existsSync(dashboardPath)) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(dashboardPath)); return; }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Dashboard not found'); return;
  }

  if (pathname === '/api/config') {
    if (req.method === 'GET') { writeJSON(res, 200, { ...config, apiKey: config.apiKey ? config.apiKey.substring(0, 10) + '...' : '' }); return; }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const newConfig = JSON.parse(body);
        if (newConfig.apiKey) config.apiKey = newConfig.apiKey;
        if (newConfig.apiKeys) config.apiKeys = newConfig.apiKeys;
        if (newConfig.listenAddr) config.listenAddr = newConfig.listenAddr;
        saveConfig(config);
        writeJSON(res, 200, { success: true });
      }
      catch (e) { writeJSON(res, 400, { error: e.message }); }
      return;
    }
  }

  if (pathname === '/api/validate' && req.method === 'GET') {
    const valid = await validateApiKey();
    writeJSON(res, 200, { valid, hasApiKey: !!config.apiKey });
    return;
  }

  if (pathname === '/api/models' && req.method === 'GET') { writeJSON(res, 200, { models: CODEBUFF_MODELS }); return; }

  if (pathname === '/api/bg' && req.method === 'GET') {
    try {
      const response = await fetch('https://peapix.com/bing/feed');
      const data = await response.json();
      const item = Array.isArray(data) ? data[0] : data;
      const imgUrl = item.fullUrl || item.imageUrl || item.url || '';
      if (imgUrl) writeJSON(res, 200, { url: imgUrl });
      else writeJSON(res, 404, { error: 'not found' });
    } catch (e) { writeJSON(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/healthz') { await handleHealthz(req, res); return; }
  if (pathname === '/v1/models') { await handleModels(req, res); return; }
  if (pathname === '/v1/chat/completions') { await handleChatCompletions(req, res); return; }
  if (pathname === '/v1/messages') { await handleClaudeMessages(req, res); return; }
  if (pathname === '/v1/messages/count_tokens') { await handleClaudeCountTokens(req, res); return; }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

// --- Opencode Config ---
function setupOpencodeConfig() {
  const models = {};
  for (const m of CODEBUFF_MODELS) {
    models[m] = { name: m.split('/').pop() };
  }
  const port = parseInt(config.listenAddr.replace(':', '')) || 8080;
  const providerEntry = {
    npm: '@ai-sdk/openai-compatible',
    name: 'Codebuff Proxy',
    options: { baseURL: `http://localhost:${port}/v1` },
    models
  };

  const configPaths = [
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
  ];
  if (process.platform === 'win32') {
    configPaths.unshift(path.join(os.homedir(), '.opencode', 'opencode.json'));
    const systemProfile = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'config', 'systemprofile', '.opencode', 'opencode.json');
    try { if (fs.existsSync(path.dirname(systemProfile))) configPaths.push(systemProfile); } catch {}
  }

  for (const configFile of configPaths) {
    try {
      const dir = path.dirname(configFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      let existing = { $schema: 'https://opencode.ai/config.json' };
      if (fs.existsSync(configFile)) {
        existing = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        const backupFile = path.join(dir, 'openconfig.b4codebuff.json');
        if (!fs.existsSync(backupFile)) {
          fs.copyFileSync(configFile, backupFile);
          console.log(`[Opencode] Backup created: ${backupFile}`);
        }
      }
      if (!existing.provider || typeof existing.provider !== 'object') existing.provider = {};
      existing.provider['codebuff'] = providerEntry;
      fs.writeFileSync(configFile, JSON.stringify(existing, null, 2));
      console.log(`[Opencode] Config updated: ${configFile}`);
    } catch (e) {
      console.error(`[Opencode] Failed to update ${configFile}: ${e.message}`);
    }
  }
}

// --- Server Startup ---
let upstream;

async function startServer() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  Codebuff Proxy - Starting...                                 ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');

  try { config = loadConfig(); } catch (e) { console.error('Failed to load config:', e.message); process.exit(1); }

  if (!config.apiKey) {
    console.log('[Warning] No Codebuff API key configured. Set CODEBUFF_API_KEY env var or add API_KEY to .config/config.json');
  }

  upstream = new UpstreamClient(config);
  const apiKeyValid = await validateApiKey();

  setupOpencodeConfig();

  const port = parseInt(config.listenAddr.replace(':', '')) || 8080;
  const server = http.createServer(handleRequest);
  server.listen(port, '0.0.0.0', () => {
    console.log(`\nCodebuff Proxy on http://0.0.0.0:${port}`);
    console.log(`  Upstream: ${config.upstreamBaseURL}`);
    console.log(`  API Key: ${config.apiKey ? 'configured (' + config.apiKey.substring(0, 10) + '...)' : 'NOT SET'}`);
    console.log(`  API Key Valid: ${apiKeyValid}`);
    console.log(`  Models: ${CODEBUFF_MODELS.length}`);
    console.log(`  Proxy API Keys: ${config.apiKeys.length > 0 ? config.apiKeys.length + ' (auth enabled)' : 'none (open access)'}`);
    console.log('');
  });
}

startServer();

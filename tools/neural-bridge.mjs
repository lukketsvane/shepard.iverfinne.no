import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const port = 8789;
const cli = process.env.SA3_CLI ? resolve(process.env.SA3_CLI) : '';
const origins = new Set(['http://localhost:3000', 'http://127.0.0.1:3000', 'https://shepard.iverfinne.no']);
let busy = false;

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 12000000) throw new Error('Audio request exceeds 12 MB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function runModel(args) {
  const command = process.platform === 'win32' ? 'powershell.exe' : cli;
  const fullArgs = process.platform === 'win32'
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cli, ...args]
    : args;
  await new Promise((done, fail) => {
    const child = spawn(command, fullArgs, { cwd: dirname(cli), windowsHide: true, stdio: 'ignore' });
    child.on('error', fail);
    child.on('close', code => code === 0 ? done() : fail(new Error('Stable Audio exited with code ' + code)));
  });
}

async function render(body, res) {
  if (!cli || !existsSync(cli)) return json(res, 503, { error: 'Stable Audio not installed: set SA3_CLI' });
  if (busy) return json(res, 429, { error: 'Model is processing another clip' });
  const { prompt, mode = 'generate', seconds = 8, noise = 0.65, audio } = body;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 300)
    return json(res, 400, { error: 'Prompt must contain 1–300 characters' });
  if (!['generate', 'variation', 'inpaint'].includes(mode) || !Number.isFinite(seconds) || seconds < 1 || seconds > 30)
    return json(res, 400, { error: 'Invalid mode or duration' });
  if (!Number.isFinite(noise) || noise < 0.1 || noise > 1)
    return json(res, 400, { error: 'Invalid noise level' });
  let input;
  if (mode !== 'generate') {
    if (typeof audio !== 'string' || audio.length > 11000000)
      return json(res, 400, { error: 'Select a short source recording' });
    input = Buffer.from(audio, 'base64');
    if (input.length < 44 || input.length > 8000000 || input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WAVE')
      return json(res, 400, { error: 'Input must be a WAV recording' });
  }
  busy = true;
  const dir = await mkdtemp(join(tmpdir(), 'shepard-sa3-'));
  try {
    const output = join(dir, 'result.wav');
    const args = ['--dit', 'sm-sfx', '--decoder', 'same-s', '--prompt', prompt.trim(), '--seconds', String(seconds), '--out', output];
    if (input) {
      const file = join(dir, 'input.wav');
      await writeFile(file, input);
      if (mode === 'variation') args.push('--init-audio', file, '--init-noise-level', String(noise));
      if (mode === 'inpaint') args.push('--init-audio', file, '--inpaint-range', String(seconds / 3) + ',' + String(seconds * 2 / 3));
    }
    await runModel(args);
    const wav = await readFile(output);
    if (wav.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Model did not produce WAV audio');
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
    res.end(wav);
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : 'Generation failed' });
  } finally {
    busy = false;
    await rm(dir, { recursive: true, force: true });
  }
}

createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !origins.has(origin)) return json(res, 403, { error: 'Origin forbidden' });
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (req.method === 'GET' && req.url === '/health')
    return json(res, 200, { model: 'stable-audio-3-small-sfx', available: Boolean(cli && existsSync(cli)), busy });
  if (req.method === 'POST' && req.url === '/render') {
    try { return await render(await readBody(req), res); }
    catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' }); }
  }
  json(res, 404, { error: 'Not found' });
}).listen(port, '127.0.0.1', () => {
  process.stdout.write('Shepard neural bridge http://127.0.0.1:' + port + '\n');
});

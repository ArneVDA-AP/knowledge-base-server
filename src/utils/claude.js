import { spawn } from 'child_process';

const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const DEFAULT_MODEL = process.env.CLASSIFY_MODEL || 'claude-haiku-4-5-20251001';

export function runClaude(prompt, { model, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_PATH, [
      '-p', '--model', model || DEFAULT_MODEL,
      '--output-format', 'json',
      '--max-turns', '1',
    ], {
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      resolve(stdout);
    });
    proc.on('error', reject);
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

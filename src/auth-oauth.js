// src/auth-oauth.js — Better Auth OAuth provider for MCP clients
import { betterAuth } from 'better-auth';
import { mcp } from 'better-auth/plugins';
import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const KB_DIR = join(homedir(), '.knowledge-base');
const AUTH_DB_PATH = join(KB_DIR, 'auth.db');

// Ensure Better Auth schema exists (idempotent — runs in ~100ms if already migrated)
{
  const db = new Database(AUTH_DB_PATH);
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user'").get();
  db.close();
  if (!tableExists) {
    console.log('[KB] Better Auth schema missing — running migration...');
    const cwd = join(dirname(fileURLToPath(import.meta.url)), '..');
    const result = spawnSync('npx', ['@better-auth/cli', 'migrate', '-y'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
      shell: true,
    });
    if (result.status === 0) {
      console.log('[KB] Better Auth migration completed');
    } else {
      console.error('[KB] Better Auth migration failed — run manually: npx @better-auth/cli migrate -y');
      console.error(result.stderr?.toString());
    }
  }
}

export const auth = betterAuth({
  database: new Database(AUTH_DB_PATH),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || `http://localhost:${process.env.KB_PORT || 3838}`,
  basePath: '/api/auth',
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    mcp({
      loginPage: '/sign-in',
    }),
  ],
});

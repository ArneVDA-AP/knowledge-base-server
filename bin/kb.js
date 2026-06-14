#!/usr/bin/env node
// bin/kb.js — CLI entry point
// Commands: start, stop, mcp, register, ingest <path>, search <query>, status, setup

import '../src/paths.js'; // loads .env from ~/.knowledge-base/.env

const command = process.argv[2];
const args = process.argv.slice(3);

const commands = {
  start:    () => import('../src/server.js').then(m => m.start()),
  stop:     () => import('../src/cli/stop.js').then(m => m.stop()),
  mcp:      () => import('../src/mcp.js').then(m => m.start()),
  register: () => import('../src/cli/register.js').then(m => m.register()),
  ingest:   () => import('../src/cli/ingest-cli.js').then(m => m.ingest(args[0])),
  search:   () => import('../src/cli/search-cli.js').then(m => m.search(args.join(' '))),
  delete:   () => import('../src/cli/delete-cli.js').then(m => m.deleteCommand(args)),
  'token-compare': () => import('../src/cli/token-compare.js').then(m => m.tokenCompare(args)),
  status:   () => import('../src/cli/status.js').then(m => m.status()),
  'capture-x': () => import('../src/capture/x-bookmarks.js').then(m => {
    const bookmarksPath = args[0] || (process.env.HOME + '/knowledgebase/x_bookmarks.md');
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    if (!vaultPath) { console.error('OBSIDIAN_VAULT_PATH not set'); process.exit(1); }
    const result = m.captureXBookmarks(bookmarksPath, vaultPath);
    console.log(`X bookmarks: ${result.created} created, ${result.skipped} skipped (${result.total} total)`);
  }),
  classify: () => {
    const dryRun = args.includes('--dry-run');
    return import('../src/classify/processor.js').then(async m => {
      const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultPath) { console.error('OBSIDIAN_VAULT_PATH not set'); process.exit(1); }
      const result = await m.processNewClippings(vaultPath, { dryRun });
      console.log(`\nClassified: ${result.processed}/${result.total} notes`);
      if (result.errors) console.log(`Errors: ${result.errors}`);
      if (dryRun) console.log('(dry run — no changes written)');
    });
  },
  summarize: () => {
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--force');
    const limitFlag = args.find(a => a.startsWith('--limit='));
    const limit = limitFlag ? parseInt(limitFlag.split('=')[1]) : 0;
    const profile = args.find(a => a.startsWith('--profile='))?.split('=')[1] ?? 'default';
    const type = args.find(a => a.startsWith('--type='))?.split('=')[1];
    return import('../src/classify/summarizer.js').then(async m => {
      const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultPath) { console.error('OBSIDIAN_VAULT_PATH not set'); process.exit(1); }
      const result = await m.summarizeUnsummarized(vaultPath, { dryRun, limit, type, profile, force });
      console.log(`\nSummarized: ${result.summarized}/${result.total} notes`);
      if (result.errors) console.log(`Errors: ${result.errors}`);
      if (dryRun) console.log('(dry run — no changes written)');
    });
  },
  consolidate: () => {
    const dryRun = args.includes('--dry-run');
    const project = args.find(a => a.startsWith('--project='))?.split('=')[1];
    return import('../src/consolidate.js').then(async m => {
      if (args.includes('--episodics')) {
        // CLS "sleep" pass: generalise stored episodic memories into semantic ones.
        const result = await m.consolidateEpisodics({ dryRun, project });
        console.log(JSON.stringify(result, null, 2));
        console.log(`\nConsolidate episodics: ${result.written} semantic written, ${result.demoted} episodics demoted of ${result.episodics} considered${dryRun ? ' (dry run)' : ''}`);
        return;
      }
      const { readFileSync } = await import('fs');
      const fileArg = args.find(a => !a.startsWith('--'));
      let text = '';
      try {
        text = fileArg ? readFileSync(fileArg, 'utf-8') : readFileSync(0, 'utf-8'); // file or stdin
      } catch (e) {
        console.error(`Could not read input: ${e.message}`); process.exit(1);
      }
      if (!text.trim()) { console.error('No input. Pass a file path or pipe session text via stdin.'); process.exit(1); }
      const result = await m.consolidate(text, { dryRun, project });
      console.log(JSON.stringify(result, null, 2));
      console.log(`\nConsolidate: ${result.written} written, ${result.skipped} skipped of ${result.extracted} extracted${dryRun ? ' (dry run — nothing written)' : ''}`);
    });
  },
  'memory-export': () => {
    const project = args.find(a => a.startsWith('--project='))?.split('=')[1];
    const fileArg = args.find(a => !a.startsWith('--'));
    return import('../src/db.js').then(async m => {
      const ndjson = m.exportMemoriesNDJSON({ project });
      const n = ndjson ? ndjson.split('\n').filter(Boolean).length : 0;
      if (fileArg) {
        const { writeFileSync } = await import('fs');
        writeFileSync(fileArg, ndjson);
        console.log(`Exported ${n} memories to ${fileArg}`);
      } else {
        console.log(ndjson);
      }
    });
  },
  'memory-import': () => {
    const fileArg = args.find(a => !a.startsWith('--'));
    return import('../src/db.js').then(async m => {
      const { readFileSync } = await import('fs');
      let ndjson = '';
      try { ndjson = fileArg ? readFileSync(fileArg, 'utf-8') : readFileSync(0, 'utf-8'); }
      catch (e) { console.error(`Could not read input: ${e.message}`); process.exit(1); }
      const res = m.importMemories(ndjson);
      console.log(`Imported ${res.imported}, skipped ${res.skipped} (duplicates/invalid) of ${res.total}`);
    });
  },
  setup:    () => import('../src/cli/setup.js').then(m => m.setup(args)),
  'safety-check': () => {
    const action = args.join(' ');
    if (!action) { console.error('Usage: kb safety-check <action description>'); process.exit(1); }
    return import('../src/safety/review.js').then(async m => {
      const result = await m.reviewDestructiveAction(action);
      console.log(JSON.stringify(result, null, 2));
      if (!result.safe) process.exit(1);
    });
  },
  vault:    () => {
    const sub = args[0];
    if (sub === 'reindex') return import('../src/cli/vault-cli.js').then(m => m.vaultReindex());
    console.log('Usage: kb vault reindex');
    process.exit(1);
  },
};

if (!command || !commands[command]) {
  console.log(`Usage: kb <command>

Commands:
  start              Start the dashboard server (default :3838)
  stop               Stop the running server
  mcp                Start MCP stdio server (used by AI tools)
  register           Register MCP server with Claude Code
  ingest <path>      Ingest a file or directory
  search <query>     Search documents
  delete <id> [...]  Delete document(s) by ID
  token-compare      Compare raw doc tokens vs KB summary tokens
  status             Show stats and server status
  vault reindex      Reindex Obsidian vault
  classify           Auto-classify new clippings/inbox notes (--dry-run to preview)
  summarize          Add AI summaries to docs without them (--dry-run, --limit=N)
  consolidate [file] Extract durable memories from a session (file or stdin; --dry-run, --project=)
  consolidate --episodics  CLS pass: generalise stored episodic memories into semantic ones (--dry-run)
  memory-export [file] Export bridge memories as NDJSON (--project= to scope; stdout if no file)
  memory-import <file> Import memories from NDJSON (dedupes on content; file or stdin)
  capture-x [path]   Capture X/Twitter bookmarks to vault
  setup              Interactive setup wizard (--auto for agent mode)
`);
  process.exit(command ? 1 : 0);
}

commands[command]().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

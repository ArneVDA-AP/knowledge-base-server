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
    return import('../src/memory/store.js').then(async M => {
      if (args.includes('--from-transcript')) {
        // Auto-SAVE half of the spine: the Stop hook pipes its JSON on stdin; read transcript_path,
        // extract the session text, consolidate into memories. Best-effort — never fails the hook.
        const { extractTranscriptText } = await import('../src/memory/spine.js');
        const { readFileSync, existsSync } = await import('fs');
        let tpath; try { tpath = JSON.parse(readFileSync(0, 'utf-8')).transcript_path; } catch { /* no hook input */ }
        if (!tpath || !existsSync(tpath)) process.exit(0);
        const text = extractTranscriptText(readFileSync(tpath, 'utf-8'));
        if (text.trim()) { try { const r = await M.consolidate(text, { project, dryRun }); console.error(`[kaiba] consolidated ${r.written} memories`); } catch { /* swallow */ } }
        process.exit(0);
      }
      const { readFileSync } = await import('fs');
      const fileArg = args.find(a => !a.startsWith('--'));
      let text = '';
      try { text = fileArg ? readFileSync(fileArg, 'utf-8') : readFileSync(0, 'utf-8'); }
      catch (e) { console.error(`Could not read input: ${e.message}`); process.exit(1); }
      if (!text.trim()) { console.error('No input. Pass a file path or pipe session text via stdin.'); process.exit(1); }
      const result = await M.consolidate(text, { dryRun, project });
      console.log(JSON.stringify(result, null, 2));
      console.log(`\nConsolidate: ${result.written} written, ${result.skipped} skipped of ${result.extracted} extracted${dryRun ? ' (dry run)' : ''}`);
    });
  },
  brief: () => {
    const project = args.find(a => a.startsWith('--project='))?.split('=')[1];
    return import('../src/memory/store.js').then(async M => {
      if (args.includes('--hook')) {
        const { briefHookOutput } = await import('../src/memory/spine.js');
        process.stdout.write(briefHookOutput({ project }));
        return;
      }
      process.stdout.write((M.briefMarkdown({ project }) || '(Kaiba: no memories yet)') + '\n');
    });
  },
  spine: () => {
    const sub = args.find(a => !a.startsWith('--')) || 'status';
    const settingsPath = args.find(a => a.startsWith('--settings='))?.split('=')[1];
    return import('../src/memory/spine.js').then(m => {
      if (sub === 'install') console.log(JSON.stringify(m.installSpine({ settingsPath }), null, 2));
      else if (sub === 'uninstall') console.log(JSON.stringify(m.uninstallSpine({ settingsPath }), null, 2));
      else if (sub === 'print') console.log(m.installSpine({ settingsPath, print: true }).preview);
      else console.log(JSON.stringify(m.spineStatus({ settingsPath }), null, 2));
    });
  },
  'memory-export': () => {
    const project = args.find(a => a.startsWith('--project='))?.split('=')[1];
    const fileArg = args.find(a => !a.startsWith('--'));
    return import('../src/memory/store.js').then(async M => {
      const ndjson = M.exportNDJSON({ project });
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
    return import('../src/memory/store.js').then(async M => {
      const { readFileSync } = await import('fs');
      let ndjson = '';
      try { ndjson = fileArg ? readFileSync(fileArg, 'utf-8') : readFileSync(0, 'utf-8'); }
      catch (e) { console.error(`Could not read input: ${e.message}`); process.exit(1); }
      const res = M.importNDJSON(ndjson);
      console.log(`Imported ${res.imported}, skipped ${res.skipped} (duplicates/invalid)`);
    });
  },
  'memory-sync': () => {
    // Trusted cross-device merge via per-machine NDJSON files in a shared Drive dir (docs/memory-bridge/08).
    const dir = args.find(a => a.startsWith('--dir='))?.split('=')[1];
    const project = args.find(a => a.startsWith('--project='))?.split('=')[1];
    const dryRun = args.includes('--dry-run');
    return import('../src/memory/store.js').then(async M => {
      const r = await M.syncMemories({ dir, project, dryRun });
      console.log(`memory-sync [${r.machine}]: pulled ${r.pulledNew} new + ${r.pulledUpdated} updated from ${r.machines.length} peer(s)${r.machines.length ? ` [${r.machines.join(', ')}]` : ''}; ${dryRun ? 'would push' : 'pushed'} ${r.pushed} → ${r.dir}${dryRun ? '  (dry run — nothing written)' : ''}`);
    });
  },
  'migrate-memories': () => {
    // One-time lift of the old documents-based memories into the first-class `memories` entity.
    return import('../src/memory/store.js').then(M => {
      const r = M.migrateFromDocuments();
      console.log(JSON.stringify(r, null, 2));
      console.log(`\nMigrated ${r.migrated} memories, skipped ${r.skipped} (duplicates/empty) of ${r.total}.`);
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
  brief              Print the session-start memory brief (--hook = SessionStart hook JSON; --project=)
  spine <cmd>        Wire the memory spine into Claude Code: install | status | print | uninstall
  consolidate [file] Distil a session into durable memories (file/stdin; --dry-run, --project=)
  memory-export [file] Export memories as NDJSON (--project= to scope; stdout if no file)
  memory-import <file> Import memories from NDJSON (dedupes on content; re-enters review queue)
  memory-sync        Sync the brain across your machines via a shared Drive dir (--dir=, --dry-run, --project=)
  migrate-memories   One-time: lift old documents-based memories into the memories table
  capture-x [path]   Capture X/Twitter bookmarks to vault
  setup              Interactive setup wizard (--auto for agent mode)
`);
  process.exit(command ? 1 : 0);
}

commands[command]().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

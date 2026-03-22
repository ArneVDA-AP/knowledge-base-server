import { existsSync, unlinkSync } from 'fs';
import { getDocument, deleteDocument } from '../db.js';

export function deleteCommand(args) {
  if (!args.length) {
    console.error('Usage: kb delete <id> [<id2> ...]');
    process.exit(1);
  }

  const ids = args.map(a => parseInt(a, 10)).filter(id => !isNaN(id));
  if (ids.length === 0) {
    console.error('Error: No valid document IDs provided.');
    process.exit(1);
  }

  let deleted = 0, notFound = 0;
  for (const id of ids) {
    const doc = getDocument(id);
    if (!doc) {
      console.error(`  Not found: ID ${id}`);
      notFound++;
      continue;
    }
    const filePath = deleteDocument(id);
    if (filePath && existsSync(filePath)) {
      try { unlinkSync(filePath); } catch {}
    }
    console.log(`  Deleted: [${doc.doc_type}] ${doc.title} (ID ${id})`);
    deleted++;
  }
  console.log(`\nDone: ${deleted} deleted, ${notFound} not found.`);
}

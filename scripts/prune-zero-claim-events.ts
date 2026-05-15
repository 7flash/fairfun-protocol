import { Database } from 'bun:sqlite';
import path from 'path';

const dbPath = path.resolve(process.cwd(), process.argv[2] || './data/fairfun.db');
const db = new Database(dbPath, { create: true });

const before = db.query(`
    select count(*) as count
    from claimEvents
    where grossAmountSol = 0
      and claimantAmountSol = 0
      and delegatorFeeSol = 0
`).get() as { count: number } | null;

const deleted = db.query(`
    delete from claimEvents
    where grossAmountSol = 0
      and claimantAmountSol = 0
      and delegatorFeeSol = 0
    returning signature
`).all() as Array<{ signature: string }>;

console.log(JSON.stringify({
    dbPath,
    zeroRowsBefore: before?.count ?? 0,
    deleted: deleted.length,
    signatures: deleted.map((row) => row.signature),
}, null, 2));

import { Database, z } from 'sqlite-zod-orm';

const db = new Database('data/fairfun.db', {
    treasuryEvents: z.object({
        signature: z.string(),
        amountSol: z.number(),
        depositorAddress: z.string(),
        timestamp: z.number(),
        createdAt: z.number()
    }),
});

const events = db.treasuryEvents.select()
    .orderBy('timestamp', 'desc')
    .limit(10)
    .all();

console.log('Recent treasury events:');
events.forEach((e: any) => {
    const date = new Date(e.timestamp).toISOString();
    console.log(`  ${date.slice(0, 19)} | ${e.amountSol.toFixed(6)} SOL | ${e.depositorAddress.slice(0, 8)}...`);
});
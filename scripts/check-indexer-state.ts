import { Database, z } from 'sqlite-zod-orm';

const db = new Database('data/fairfun.db', {
    metadata: z.object({
        key: z.string(),
        value: z.string()
    }),
});

const getMeta = (key: string) => db.metadata.select().where({ key }).get()?.value ?? null;

console.log('Indexer state:');
console.log('  lastTreasurySignatureSeen:', getMeta('lastTreasurySignatureSeen'));
console.log('  totalFeesAccumulatedSol:', getMeta('totalFeesAccumulatedSol'));
console.log('  lastTreasuryScanAt:', getMeta('lastTreasuryScanAt') ? new Date(Number(getMeta('lastTreasuryScanAt'))).toISOString() : 'null');
console.log('  launchTimestamp:', getMeta('launchTimestamp') ? new Date(Number(getMeta('launchTimestamp'))).toISOString() : 'null');
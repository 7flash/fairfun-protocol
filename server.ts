import { configure, measureSync } from 'measure-fn';
import { serve } from 'tradjs';
import { config } from './lib/config';

configure({
    timestamps: true,
    maxResultLength: 160,
});

const port = config.app.port;
const app = await serve({
    port,
    defaultTitle: config.app.siteTitle,
});

measureSync('Web app ready', () => ({
    port,
    title: config.app.siteTitle,
    tokenMint: config.token.mint,
}));

export default app;

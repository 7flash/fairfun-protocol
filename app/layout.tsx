import { config } from '../lib/config';

export default function RootLayout({ children }: { children: any }) {
    return (
        <html lang="en">
            <head>
                <meta charSet="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>{config.app.siteTitle}</title>
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
            </head>
            <body style={{ margin: 0 }}>
                <main id="tradjs-page-content">{children}</main>
            </body>
        </html>
    );
}

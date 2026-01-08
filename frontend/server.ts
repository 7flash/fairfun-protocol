import { serve, buildScript, buildStyle } from "@ments/web";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3005";
const PROGRAM_ID = "GYQP75VdPpCU1xPsJS7CUkcBqzL718j7ihNmgJ3VESd7";

// Build assets on startup
let scriptPath: string;
let stylePath: string;

async function init() {
    scriptPath = await buildScript("./App.client.tsx", true);
    stylePath = await buildStyle("./App.css");
}

// HTML template with links to cached assets
const html = () => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stardust Protocol</title>
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@18.2.0",
      "react-dom/client": "https://esm.sh/react-dom@18.2.0/client",
      "react/jsx-runtime": "https://esm.sh/react@18.2.0/jsx-runtime",
      "@solana/web3.js": "https://esm.sh/@solana/web3.js@1.87.6",
      "bs58": "https://esm.sh/bs58@5.0.0",
      "tweetnacl": "https://esm.sh/tweetnacl@1.0.3"
    }
  }
  </script>
  <link rel="stylesheet" href="${stylePath}">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${scriptPath}"></script>
</body>
</html>`;

async function handler(req: Request): Promise<Response | null> {
    const url = new URL(req.url);

    // Serve the app
    if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(html(), {
            headers: { "Content-Type": "text/html" },
        });
    }

    // Proxy API calls to backend
    if (url.pathname.startsWith("/api/")) {
        const backendUrl = BACKEND_URL + url.pathname + url.search;
        const resp = await fetch(backendUrl, {
            method: req.method,
            headers: req.headers,
            body: req.method !== "GET" ? await req.text() : undefined,
        });
        return new Response(resp.body, {
            status: resp.status,
            headers: resp.headers,
        });
    }

    return null;
}

// Initialize and serve
await init();
serve(handler);

console.log(`Stardust Frontend running on port ${process.env.BUN_PORT}`);
console.log(`Backend: ${BACKEND_URL}`);
console.log(`Program: ${PROGRAM_ID}`);

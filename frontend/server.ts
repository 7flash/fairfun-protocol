import { serve, buildScript, buildStyle } from "@ments/web";
import { readFile } from "fs/promises";
import { join } from "path";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3005";
const WHEEL_PROGRAM_ID = "3M12BfitAEYz14WJBMnjahEuSvhsWhjfGJXbzur26o2U";

// Build assets on startup
let scriptPath: string;
let stylePath: string;
let adminScriptPath: string;
let wheelDemoScriptPath: string;

async function init() {
  console.log("Initializing frontend build...");
  scriptPath = await buildScript("./App.client.tsx", true);
  stylePath = await buildStyle("./App.css");
  adminScriptPath = await buildScript("./Admin.client.tsx", true);
  wheelDemoScriptPath = await buildScript("./WheelDemoClient.tsx", true);
}

// HTML template with links to cached assets
const html = (script: string, title: string = "Stardust Protocol") => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@18.2.0",
      "react-dom/client": "https://esm.sh/react-dom@18.2.0/client",
      "react/jsx-runtime": "https://esm.sh/react@18.2.0/jsx-runtime",
      "react/jsx-dev-runtime": "https://esm.sh/react@18.2.0/jsx-dev-runtime",
      "@solana/web3.js": "https://esm.sh/@solana/web3.js@1.87.6",
      "@solana/spl-token": "https://esm.sh/@solana/spl-token@0.4.5",
      "@coral-xyz/anchor": "https://esm.sh/@coral-xyz/anchor@0.29.0",
      "bs58": "https://esm.sh/bs58@5.0.0",
      "tweetnacl": "https://esm.sh/tweetnacl@1.0.3",
      "buffer": "https://esm.sh/buffer@6.0.3",
      "react-custom-roulette": "https://esm.sh/react-custom-roulette@1.4.1?external=react,react-dom"
    }
  }
  </script>
  <script type="module">
    // Buffer polyfill for browser
    import { Buffer } from 'buffer';
    window.Buffer = Buffer;
  </script>
  <link rel="stylesheet" href="${stylePath}">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${script}"></script>
</body>
</html>`;

async function handler(req: Request): Promise<Response | null> {
  const url = new URL(req.url);

  // Serve the main app
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(html(scriptPath), {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Serve admin page
  if (url.pathname === "/admin") {
    return new Response(html(adminScriptPath, "Galaxy Wheel Admin"), {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Serve wheel demo page
  if (url.pathname === "/wheel-demo") {
    return new Response(html(wheelDemoScriptPath, "Galaxy Wheel Demo"), {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Serve static assets from public folder
  if (url.pathname.startsWith("/assets/")) {
    try {
      const filePath = join(import.meta.dir, "public", url.pathname);
      const file = await readFile(filePath);
      const ext = url.pathname.split('.').pop() || '';
      const mimeTypes: Record<string, string> = {
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'svg': 'image/svg+xml',
        'webp': 'image/webp',
      };
      return new Response(file, {
        headers: { "Content-Type": mimeTypes[ext] || "application/octet-stream" },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
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
console.log(`Wheel Program: ${WHEEL_PROGRAM_ID}`);
console.log(`Admin page: http://localhost:${process.env.BUN_PORT}/admin`);
console.log(`Wheel demo: http://localhost:${process.env.BUN_PORT}/wheel-demo`);

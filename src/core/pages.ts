// HTML pages served by the proxy itself. Every interpolated value is escaped.

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export const LOGO_PATH = '/__portpilot/logo.png';

// Error page HTML generator - matches landing page styling
export function getErrorPage(rawName: string, rawPort: string | number, rawPath: string, errorMessage: string): string {
  const projectName = escapeHtml(rawName);
  const projectPort = escapeHtml(rawPort);
  const projectPath = escapeHtml(rawPath);
  const cleanError = escapeHtml(errorMessage.replace(/^connect /, ''));
  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8"/>
        <meta content="width=device-width, initial-scale=1.0" name="viewport"/>
        <title>PortPilot - ${projectName} Not Responding</title>
        <link rel="icon" href="${LOGO_PATH}" type="image/png" />
        <script src="https://cdn.tailwindcss.com?plugins=forms,typography"></script>
        <script>
          tailwind.config = {
            darkMode: "class",
            theme: {
              extend: {
                colors: {
                  primary: "#FFFFFF",
                  "primary-dark": "#000000",
                  "background-light": "#F8FAFC",
                  "background-dark": "#050505",
                  "surface-dark": "#0F0F0F",
                  "border-dark": "#27272a",
                  "text-secondary": "#A1A1AA",
                },
                fontFamily: {
                  display: ["Inter", "sans-serif"],
                  mono: ["Fira Code", "monospace"],
                },
                borderRadius: {
                  DEFAULT: "0.5rem",
                  "xl": "0.75rem",
                  "2xl": "1rem",
                },
                backgroundImage: {
                  'grid-pattern': "linear-gradient(to right, #27272a 1px, transparent 1px), linear-gradient(to bottom, #27272a 1px, transparent 1px)",
                }
              },
            },
          };
        </script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet"/>
        <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet"/>
        <style>
          body { font-family: 'Inter', sans-serif; }
          .grid-bg {
            background-size: 40px 40px;
            mask-image: radial-gradient(circle at center, black 0%, transparent 80%);
            -webkit-mask-image: radial-gradient(circle at center, black 0%, transparent 80%);
          }
        </style>
      </head>
      <body class="bg-background-dark text-white min-h-screen flex flex-col relative overflow-hidden font-display antialiased selection:bg-white selection:text-black">
        <div class="absolute inset-0 z-0 opacity-[0.15] bg-grid-pattern grid-bg pointer-events-none"></div>

        <nav class="absolute top-0 w-full z-50 p-6">
          <div class="max-w-7xl mx-auto flex items-center gap-3">
            <div class="relative w-8 h-8 flex items-center justify-center">
              <img src="${LOGO_PATH}" alt="PortPilot" class="w-8 h-8 object-contain" />
            </div>
            <span class="font-bold text-xl tracking-tight">PortPilot</span>
          </div>
        </nav>

        <main class="relative z-10 flex-grow flex items-center justify-center p-4 sm:p-6">
          <div class="w-full max-w-lg">
            <div class="mb-10">
              <div class="w-16 h-16 bg-red-500/10 border border-red-500/20 rounded-2xl flex items-center justify-center mb-6 text-red-500 shadow-lg shadow-red-900/20">
                <span class="material-icons text-3xl">link_off</span>
              </div>
              <h1 class="text-3xl sm:text-4xl font-bold tracking-tight mb-3 text-white">${projectName} is not responding</h1>
              <p class="text-lg text-text-secondary">The dev server isn't running on port <span class="text-white font-mono bg-white/10 px-1.5 py-0.5 rounded text-base mx-1">${projectPort}</span></p>
            </div>

            <div class="bg-surface-dark border border-border-dark rounded-xl overflow-hidden mb-8 shadow-2xl">
              <div class="px-6 py-3 border-b border-border-dark bg-white/5 flex items-center gap-2">
                <span class="material-icons text-gray-500 text-sm">terminal</span>
                <h2 class="text-xs font-bold text-gray-400 uppercase tracking-widest">Process Details</h2>
              </div>
              <div class="p-6 grid grid-cols-[110px_1fr] gap-y-5 text-sm">
                <div class="text-text-secondary font-medium">Project</div>
                <div class="text-white font-semibold">${projectName}</div>
                <div class="text-text-secondary font-medium">Expected Port</div>
                <div class="font-mono text-white">${projectPort}</div>
                <div class="text-text-secondary font-medium">Path</div>
                <div class="font-mono text-gray-400 break-all">${projectPath}</div>
                <div class="text-text-secondary font-medium">Error</div>
                <div class="font-mono text-red-400 bg-red-500/10 px-2 py-0.5 rounded w-fit border border-red-500/20">${cleanError}</div>
              </div>
            </div>

            <div class="mb-10">
              <h3 class="text-xs font-bold text-text-secondary uppercase tracking-widest mb-5 ml-1">Quick Fix</h3>
              <div class="space-y-4">
                <div class="group">
                  <div class="flex items-center gap-2 mb-2 ml-1">
                    <span class="w-5 h-5 rounded-full bg-white/10 text-white flex items-center justify-center text-[10px] font-bold border border-white/20">1</span>
                    <span class="text-sm text-gray-300">Start the dev server</span>
                  </div>
                  <div class="bg-black border border-border-dark rounded-lg p-3 flex items-center justify-between group-hover:border-gray-600 transition-colors cursor-pointer shadow-sm" onclick="navigator.clipboard.writeText('portpilot start ${projectName} -d')">
                    <code class="text-sm font-mono text-green-400">portpilot start ${projectName} -d</code>
                    <span class="material-icons text-gray-600 text-sm group-hover:text-white transition-colors" title="Copy command">content_copy</span>
                  </div>
                </div>
                <div class="group">
                  <div class="flex items-center gap-2 mb-2 ml-1">
                    <span class="w-5 h-5 rounded-full bg-white/10 text-white flex items-center justify-center text-[10px] font-bold border border-white/20">2</span>
                    <span class="text-sm text-gray-300">Or restart it</span>
                  </div>
                  <div class="bg-black border border-border-dark rounded-lg p-3 flex items-center justify-between group-hover:border-gray-600 transition-colors cursor-pointer shadow-sm" onclick="navigator.clipboard.writeText('portpilot restart ${projectName}')">
                    <code class="text-sm font-mono text-green-400">portpilot restart ${projectName}</code>
                    <span class="material-icons text-gray-600 text-sm group-hover:text-white transition-colors" title="Copy command">content_copy</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="flex flex-col sm:flex-row items-center gap-4">
              <button onclick="location.reload()" class="w-full sm:w-auto bg-white text-black hover:bg-gray-200 active:bg-gray-300 transition-colors px-6 py-3 rounded-lg font-bold flex items-center justify-center gap-2 cursor-pointer">
                <span class="material-icons text-lg">refresh</span>
                Refresh Page
              </button>
              <a href="https://github.com/VolchokLV/portpilot" target="_blank" class="w-full sm:w-auto bg-transparent border border-border-dark hover:border-gray-600 text-white px-6 py-3 rounded-lg font-medium flex items-center justify-center gap-2 transition-colors">
                <span class="material-icons text-lg">help_outline</span>
                Get Help
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  `;
}

export function getNotFoundPage(rawHost: string): string {
  const host = escapeHtml(rawHost);
  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8"/>
        <meta content="width=device-width, initial-scale=1.0" name="viewport"/>
        <title>PortPilot - Project Not Found</title>
        <link rel="icon" href="${LOGO_PATH}" type="image/png" />
        <script src="https://cdn.tailwindcss.com?plugins=forms,typography"></script>
        <script>
          tailwind.config = {
            darkMode: "class",
            theme: {
              extend: {
                colors: {
                  primary: "#FFFFFF",
                  "primary-dark": "#000000",
                  "background-light": "#F8FAFC",
                  "background-dark": "#050505",
                  "surface-dark": "#0F0F0F",
                  "border-dark": "#27272a",
                  "text-secondary": "#A1A1AA",
                },
                fontFamily: {
                  display: ["Inter", "sans-serif"],
                  mono: ["Fira Code", "monospace"],
                },
                borderRadius: {
                  DEFAULT: "0.5rem",
                  "xl": "0.75rem",
                  "2xl": "1rem",
                },
                backgroundImage: {
                  'grid-pattern': "linear-gradient(to right, #27272a 1px, transparent 1px), linear-gradient(to bottom, #27272a 1px, transparent 1px)",
                }
              },
            },
          };
        </script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet"/>
        <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet"/>
        <style>
          body { font-family: 'Inter', sans-serif; }
          .grid-bg {
            background-size: 40px 40px;
            mask-image: radial-gradient(circle at center, black 0%, transparent 80%);
            -webkit-mask-image: radial-gradient(circle at center, black 0%, transparent 80%);
          }
        </style>
      </head>
      <body class="bg-background-dark text-white min-h-screen flex flex-col relative overflow-hidden font-display antialiased selection:bg-white selection:text-black">
        <div class="absolute inset-0 z-0 opacity-[0.15] bg-grid-pattern grid-bg pointer-events-none"></div>

        <nav class="absolute top-0 w-full z-50 p-6">
          <div class="max-w-7xl mx-auto flex items-center gap-3">
            <div class="relative w-8 h-8 flex items-center justify-center">
              <img src="${LOGO_PATH}" alt="PortPilot" class="w-8 h-8 object-contain" />
            </div>
            <span class="font-bold text-xl tracking-tight">PortPilot</span>
          </div>
        </nav>

        <main class="relative z-10 flex-grow flex items-center justify-center p-4 sm:p-6">
          <div class="w-full max-w-lg">
            <div class="mb-10">
              <div class="w-16 h-16 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex items-center justify-center mb-6 text-amber-500 shadow-lg shadow-amber-900/20">
                <span class="material-icons text-3xl">search_off</span>
              </div>
              <h1 class="text-3xl sm:text-4xl font-bold tracking-tight mb-3 text-white">Project Not Found</h1>
              <p class="text-lg text-text-secondary">No project registered for <span class="text-white font-mono bg-white/10 px-1.5 py-0.5 rounded text-base mx-1">${host}</span></p>
            </div>

            <div class="bg-surface-dark border border-border-dark rounded-xl overflow-hidden mb-8 shadow-2xl">
              <div class="px-6 py-3 border-b border-border-dark bg-white/5 flex items-center gap-2">
                <span class="material-icons text-gray-500 text-sm">info</span>
                <h2 class="text-xs font-bold text-gray-400 uppercase tracking-widest">How to Register</h2>
              </div>
              <div class="p-6">
                <p class="text-text-secondary mb-4">Navigate to your project directory and run:</p>
                <div class="bg-black border border-border-dark rounded-lg p-3 flex items-center justify-between group hover:border-gray-600 transition-colors cursor-pointer shadow-sm" onclick="navigator.clipboard.writeText('portpilot add')">
                  <code class="text-sm font-mono text-green-400">portpilot add [project-name]</code>
                  <span class="material-icons text-gray-600 text-sm group-hover:text-white transition-colors" title="Copy command">content_copy</span>
                </div>
              </div>
            </div>

            <div class="mb-10">
              <h3 class="text-xs font-bold text-text-secondary uppercase tracking-widest mb-5 ml-1">Useful Commands</h3>
              <div class="space-y-3">
                <div class="bg-black border border-border-dark rounded-lg p-3 flex items-center justify-between group hover:border-gray-600 transition-colors cursor-pointer shadow-sm" onclick="navigator.clipboard.writeText('portpilot list')">
                  <code class="text-sm font-mono text-gray-400">portpilot list</code>
                  <span class="text-xs text-text-secondary">View all projects</span>
                </div>
                <div class="bg-black border border-border-dark rounded-lg p-3 flex items-center justify-between group hover:border-gray-600 transition-colors cursor-pointer shadow-sm" onclick="navigator.clipboard.writeText('portpilot status')">
                  <code class="text-sm font-mono text-gray-400">portpilot status</code>
                  <span class="text-xs text-text-secondary">Check PortPilot status</span>
                </div>
              </div>
            </div>

            <div class="flex flex-col sm:flex-row items-center gap-4">
              <button onclick="location.reload()" class="w-full sm:w-auto bg-white text-black hover:bg-gray-200 active:bg-gray-300 transition-colors px-6 py-3 rounded-lg font-bold flex items-center justify-center gap-2 cursor-pointer">
                <span class="material-icons text-lg">refresh</span>
                Refresh Page
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  `;
}

export const CHROME_CSS = `
[data-chrome] { position: fixed; inset: 0; pointer-events: none; font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; color: #f2f2f4; user-select: none; }
[data-chrome] * { box-sizing: border-box; }
[data-chrome] [hidden] { display: none !important; }
.hinge-glass { background: rgba(24, 24, 28, 0.86); backdrop-filter: blur(14px); border: 1px solid rgba(255, 255, 255, 0.1); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35); }
.hinge-menu { position: absolute; display: flex; gap: 2px; padding: 3px; border-radius: 999px; opacity: 0; transform: translateY(-4px); transition: opacity 120ms ease, transform 120ms ease; }
.hinge-menu.shown { opacity: 1; transform: none; pointer-events: auto; }
.hinge-menu button { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 999px; background: transparent; color: inherit; cursor: pointer; }
.hinge-menu button:hover { background: rgba(255, 255, 255, 0.12); }
.hinge-menu button[aria-pressed="true"] { background: rgba(120, 170, 255, 0.28); color: #cfe0ff; }
.hinge-menu button.close:hover { background: rgba(255, 80, 80, 0.3); }
.hinge-toasts { position: absolute; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.hinge-toast { max-width: 100%; padding: 7px 12px; border-radius: 10px; overflow: hidden; position: relative; animation: hinge-in 140ms ease; overflow-wrap: anywhere; }
.hinge-toast.error { background: rgba(92, 24, 28, 0.9); border-color: rgba(255, 120, 120, 0.35); }
.hinge-toast .bar { position: absolute; left: 0; bottom: 0; height: 2px; background: #7fb0ff; transition: width 120ms linear; }
@keyframes hinge-in { from { opacity: 0; transform: translateY(-4px); } }
.hinge-panel { position: absolute; border-radius: 14px; padding: 12px; pointer-events: auto; user-select: text; overflow-x: hidden; overflow-y: auto; }
.hinge-panel h2 button { font-size: 11px; padding: 2px 8px; }
.hinge-panel h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
.hinge-panel h3 { margin: 12px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: #a8a8b3; }
.hinge-panel .row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid rgba(255, 255, 255, 0.07); }
.hinge-panel .row:first-of-type { border-top: 0; }
.hinge-panel .grow { flex: 1; min-width: 0; }
.hinge-panel .name { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hinge-panel .sub { font-size: 11px; color: #a8a8b3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hinge-panel .help { font-size: 11px; color: #a8a8b3; }
.hinge-panel .badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: rgba(120, 170, 255, 0.22); color: #cfe0ff; }
.hinge-panel button, .hinge-panel select, .hinge-panel input[type="text"] { font: inherit; color: inherit; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 8px; padding: 4px 8px; }
.hinge-panel button { cursor: pointer; white-space: nowrap; }
.hinge-panel button:hover { background: rgba(255, 255, 255, 0.16); }
.hinge-panel button.primary { background: #3b6fd8; border-color: #3b6fd8; }
.hinge-panel button:disabled { opacity: 0.5; cursor: default; }
.hinge-panel input[type="text"] { width: 100%; }
.hinge-panel select { width: 100%; }
.hinge-panel option { background: #222; }
.hinge-panel label.check { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
.hinge-panel .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; }
.hinge-panel .field { display: flex; flex-direction: column; gap: 3px; margin: 6px 0; }
.hinge-panel .note { font-size: 11px; color: #a8a8b3; margin: 8px 0 0; }
.hinge-panel .path { font: 11px ui-monospace, Consolas, monospace; color: #c8c8d0; overflow-wrap: anywhere; }
.hinge-panel .empty { color: #a8a8b3; padding: 6px 0; }
.hinge-swatches { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.hinge-swatches button { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 6px; }
.hinge-swatches button[aria-pressed="true"] { border-color: #7fb0ff; background: rgba(120, 170, 255, 0.16); }
.hinge-swatches .dot { width: 30px; height: 30px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.3); }
.hinge-fps { position: absolute; font: 600 10px ui-monospace, Consolas, monospace; color: rgba(255, 255, 255, 0.75); text-shadow: 0 1px 2px #000; transform: translate(-50%, -100%); }
`;

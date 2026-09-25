function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function recordProgressHtml(): string {
  return `<!doctype html><html><body style="font-family:sans-serif;padding:16px;white-space:pre-wrap"><pre id="t"></pre></body></html>`;
}

export function recordResultHtml(reportPath: string): string {
  return `<!doctype html><html><body style="font-family:sans-serif;padding:16px">
<p>Report written to:</p>
<pre>${escapeHtml(reportPath)}</pre>
<button onclick="window.close()">Close</button>
</body></html>`;
}

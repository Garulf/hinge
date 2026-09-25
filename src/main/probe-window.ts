function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function recordProgressHtml(): string {
  return `<!doctype html><html><body style="font-family:sans-serif;padding:16px"><pre id="t" style="white-space:pre-wrap"></pre></body></html>`;
}

export function recordResultHtml(reportPath: string, logPath?: string): string {
  const logBlock = logPath ? `<p>Log:</p>\n<pre>${escapeHtml(logPath)}</pre>\n` : "";
  return `<!doctype html><html><body style="font-family:sans-serif;padding:16px">
<p>Report written to:</p>
<pre>${escapeHtml(reportPath)}</pre>
${logBlock}<button onclick="window.close()">Close</button>
</body></html>`;
}

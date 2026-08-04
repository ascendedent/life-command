/** Browser-side file download for CSV exports (no server round-trip needed). */
export function downloadText(filename: string, body: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

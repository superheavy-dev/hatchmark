import { type DiagnosticReport, renderHuman } from "../diagnostics/index.js";
import { esc } from "../render/svg.js";
import { DEFAULT_THEME, type Theme } from "../render/theme.js";

const STYLES: Record<string, string> = {
  "1": "hm-dx-strong",
  "31": "hm-dx-error",
  "33": "hm-dx-warning",
  "34": "hm-dx-gutter",
  "36": "hm-dx-note",
};

const ANSI_RUN = new RegExp(
  `${String.fromCharCode(27)}\\[(\\d+)m([\\s\\S]*?)${String.fromCharCode(27)}\\[0m`,
  "g",
);

export function diagnosticsHtml(report: DiagnosticReport): string {
  return esc(renderHuman(report, { color: true })).replace(
    ANSI_RUN,
    (_, code: string, text: string) =>
      STYLES[code] ? `<span class="${STYLES[code]}">${text}</span>` : text,
  );
}

export function overlayHtml(report: DiagnosticReport, theme: Theme = DEFAULT_THEME): string {
  const count = `${report.error_count} error${report.error_count === 1 ? "" : "s"}`;
  const style = [
    `#hm-dev-overlay{position:fixed;inset:0;z-index:2147483647;display:flex;justify-content:center;align-items:flex-start;padding:48px 24px;overflow:auto;background:color-mix(in srgb,var(--hm-page) 80%,transparent);font:400 13px/18px var(--hm-font);color:var(--hm-text);font-variant-numeric:tabular-nums}`,
    `#hm-dev-overlay .hm-dx-panel{display:flex;flex-direction:column;gap:14px;width:min(960px,100%);padding:${theme.density.cardPadding}px;background:var(--hm-card);border:1px solid var(--hm-border-strong);border-radius:${theme.radius.card}px;box-shadow:var(--hm-shadow)}`,
    `#hm-dev-overlay .hm-dx-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}#hm-dev-overlay h2{margin:0;font-size:14px;line-height:20px;font-weight:500}#hm-dev-overlay p{margin:2px 0 0;font-size:12px;line-height:16px;color:var(--hm-text-muted)}`,
    `#hm-dev-overlay button{font:inherit;font-size:12px;line-height:16px;font-weight:500;padding:3px 10px;border:1px solid var(--hm-border);border-radius:${theme.radius.control}px;background:var(--hm-card-alt);color:var(--hm-text-muted);cursor:pointer}#hm-dev-overlay button:hover{color:var(--hm-text)}#hm-dev-overlay button:focus-visible{outline:2px solid var(--hm-focus);outline-offset:1px}`,
    `#hm-dev-overlay pre{margin:0;padding:12px 14px;overflow:auto;background:var(--hm-card-alt);border:1px solid var(--hm-border);border-radius:${theme.radius.control}px;font:400 12px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;tab-size:4}`,
    `.hm-dx-error{color:var(--hm-bad)}.hm-dx-warning{color:var(--hm-c2)}.hm-dx-note{color:var(--hm-c1)}.hm-dx-gutter{color:var(--hm-text-subtle)}.hm-dx-strong{font-weight:600}.hm-dx-count{color:var(--hm-bad)}`,
  ].join("");
  return [
    `<div id="hm-dev-overlay" role="alertdialog" aria-modal="false" aria-labelledby="hm-dev-overlay-t"><style>${style}</style>`,
    `<section class="hm-dx-panel"><header class="hm-dx-head"><div><h2 id="hm-dev-overlay-t">Hatchmark found <span class="hm-dx-count">${count}</span></h2>`,
    `<p>The page shows the last good build. Fix the files and save; this clears on the next good build.</p></div>`,
    `<button type="button" onclick="this.closest('#hm-dev-overlay').remove()">Dismiss</button></header>`,
    `<pre>${diagnosticsHtml(report)}</pre></section></div>`,
  ].join("");
}

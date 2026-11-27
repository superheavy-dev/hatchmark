import type { GalleryEntry } from "./entries.js";

/** What the preview was built from. Both fields are absent for a local build. */
export interface BuildInfo {
  /** Pull request number; absent for a build of main. */
  pr?: number;
  /** Full commit sha the site was built from. */
  sha?: string;
}

/** Everything the static site depends on. */
export interface SiteInput {
  entries: readonly GalleryEntry[];
  head: string;
  build: BuildInfo;
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const STYLE = `:root {
  --bg: #ffffff;
  --fg: #141414;
  --muted: #6b6b6b;
  --line: #e4e4e4;
  --surface: #f7f7f7;
  color-scheme: light;
  font-family: "IBM Plex Sans", system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
[data-theme="dark"] {
  --bg: #111111;
  --fg: #ececec;
  --muted: #9b9b9b;
  --line: #2b2b2b;
  --surface: #181818;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); }
a { color: inherit; }
code { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12px; color: var(--muted); }`;

/** Escapes text for HTML element content and double-quoted attributes. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** One line naming the build, such as `PR #12 · 1a5224b`. */
export function buildLabel(build: BuildInfo): string {
  const source = build.pr !== undefined ? `PR #${build.pr}` : build.sha ? "main" : "local build";
  return build.sha ? `${source} · ${build.sha.slice(0, 7)}` : source;
}

function groupByComponent(entries: readonly GalleryEntry[]): Map<string, GalleryEntry[]> {
  const groups = new Map<string, GalleryEntry[]>();
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const id of [entry.component, entry.variant]) {
      if (!ID.test(id))
        throw new Error(`gallery id "${id}" must be lowercase letters, digits and dashes`);
    }
    const key = `${entry.component}--${entry.variant}`;
    if (seen.has(key))
      throw new Error(`gallery entry ${entry.component}/${entry.variant} is registered twice`);
    seen.add(key);
    const group = groups.get(entry.component);
    if (group) group.push(entry);
    else groups.set(entry.component, [entry]);
  }
  return groups;
}

/** Favicons from assets/brand/, copied to the site root by build.ts. */
const ICONS = `<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon-16.png" type="image/png" sizes="16x16">
<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon-180.png">`;

function htmlDocument(title: string, style: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
${ICONS}
<style>
${STYLE}
${style}
</style>${head ? `\n${head}` : ""}
</head>
<body>
${body}
</body>
</html>
`;
}

const SHELL_STYLE = `html, body { height: 100%; }
body { display: flex; flex-direction: column; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
header .brand { display: flex; align-items: center; gap: 10px; padding-block: 2px; font-weight: 600; }
header .brand img { display: block; height: 24px; width: auto; }
[data-theme="dark"] .brand .light, :root:not([data-theme="dark"]) .brand .dark { display: none; }
header .info { color: var(--muted); margin-right: auto; }
[role="group"] { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
button { font: inherit; color: var(--muted); background: none; border: 0; padding: 3px 10px; cursor: pointer; }
button + button { border-left: 1px solid var(--line); }
button[aria-pressed="true"] { color: var(--fg); background: var(--surface); }
main { flex: 1; display: flex; justify-content: center; background: var(--surface); min-height: 0; }
iframe { width: 100%; height: 100%; border: 0; background: var(--bg); }
body[data-width="mobile"] iframe { width: 390px; border-inline: 1px solid var(--line); }`;

const SHELL_SCRIPT = `const frame = document.getElementById("frame");
const VIEWS = {
  components: "components/",
  dashboard: "dashboard/sales/",
  period: "dashboard/explorer/",
  periods: "periods/",
};
const state = {
  view: "components",
  theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  width: "desktop",
  section: "",
};
function read() {
  state.section = "";
  for (const [key, value] of new URLSearchParams(location.hash.slice(1))) {
    if (key in state) state[key] = value;
  }
}
function frameSrc() {
  const page = (VIEWS[state.view] ?? VIEWS.components) + location.search;
  return state.view === "components" && state.section ? page + "#" + state.section : page;
}
function writeHash() {
  const params = new URLSearchParams(state);
  if (!state.section) params.delete("section");
  history.replaceState(null, "", "#" + params);
}
function themeFrame() {
  const root = frame.contentDocument?.documentElement;
  if (root) root.dataset.theme = state.theme;
}
function apply() {
  const src = frameSrc();
  if (frame.getAttribute("src") !== src) frame.setAttribute("src", src);
  document.documentElement.dataset.theme = state.theme;
  document.body.dataset.width = state.width;
  for (const button of document.querySelectorAll("button[data-key]")) {
    button.setAttribute("aria-pressed", String(state[button.dataset.key] === button.value));
  }
  themeFrame();
  writeHash();
}
frame.addEventListener("load", () => {
  themeFrame();
  const inner = frame.contentWindow;
  if (!inner || state.view !== "components") return;
  inner.addEventListener("hashchange", () => {
    state.section = inner.location.hash.slice(1);
    frame.setAttribute("src", frameSrc());
    writeHash();
  });
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-key]");
  if (!button) return;
  state[button.dataset.key] = button.value;
  apply();
});
addEventListener("hashchange", () => {
  read();
  apply();
});
read();
apply();`;

function toggle(key: string, label: string, options: [string, string][]): string {
  const buttons = options.map(
    ([value, text]) =>
      `<button type="button" data-key="${key}" value="${value}" aria-pressed="false">${text}</button>`,
  );
  return `<div role="group" aria-label="${label}">${buttons.join("")}</div>`;
}

function shell(input: SiteInput): string {
  const label = buildLabel(input.build);
  const body = `<header>
<strong class="brand"><img class="light" src="/_brand/hatchmark-mark-light.svg" alt="Hatchmark" width="19" height="24"><img class="dark" src="/_brand/hatchmark-mark-dark.svg" alt="Hatchmark" width="19" height="24"><span>preview</span></strong>
<span class="info" title="${escapeHtml(input.build.sha ?? "")}">${escapeHtml(label)}</span>
${toggle("view", "View", [
  ["components", "Components"],
  ["dashboard", "Example dashboard"],
  ["period", "Date range picker"],
  ["periods", "Picker variants"],
])}
${toggle("theme", "Theme", [
  ["light", "Light"],
  ["dark", "Dark"],
])}
${toggle("width", "Width", [
  ["desktop", "Desktop"],
  ["mobile", "390 px"],
])}
</header>
<main><iframe id="frame" title="Preview" src="components/"></iframe></main>
<script>
${SHELL_SCRIPT}
</script>`;
  return htmlDocument(`Hatchmark preview · ${label}`, SHELL_STYLE, body);
}

const GALLERY_STYLE = `main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
h2 { font-size: 16px; font-weight: 600; margin: 0 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
p { margin: 0 0 8px; color: var(--muted); }
nav ul { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 0; margin: 16px 0 32px; }
section { margin-bottom: 40px; }
figure { margin: 0 0 24px; }
figcaption { display: flex; gap: 8px; align-items: baseline; margin-bottom: 8px; }
.tile { border: 1px solid var(--line); border-radius: 8px; padding: 16px; overflow-x: auto; }
footer { color: var(--muted); border-top: 1px solid var(--line); padding-top: 12px; }`;

/**
 * Sends a gallery opened outside the shell to the shell, carrying its query string and its fragment as the section, so
 * every link gets the toolbar. Inside the shell's iframe the page is not the top window and stays.
 */
const GALLERY_REDIRECT = `<script>
if (window.top === window.self) {
  const section = location.hash.slice(1);
  location.replace("../" + location.search + (section ? "#" + new URLSearchParams({ section }) : ""));
}
</script>`;

function gallery(input: SiteInput): string {
  const head = `${GALLERY_REDIRECT}${input.head ? `\n${input.head}` : ""}`;
  const groups = groupByComponent(input.entries);
  const label = escapeHtml(buildLabel(input.build));
  const sha = escapeHtml(input.build.sha ?? "local");
  if (groups.size === 0) {
    const body = `<main>
<h1>No components yet</h1>
<p>The renderer registers gallery entries in <code>packages/preview/src/entries.ts</code>.</p>
<p>Build: ${label} (<code>${sha}</code>)</p>
</main>`;
    return htmlDocument("Hatchmark components", GALLERY_STYLE, body, head);
  }
  const nav = [...groups].map(
    ([component, variants]) =>
      `<li><a href="#${component}">${component}</a> <code>${variants.length}</code></li>`,
  );
  const sections = [...groups].map(([component, variants]) => {
    const figures = variants.map(
      (entry) => `<figure id="${component}--${entry.variant}">
<figcaption>${escapeHtml(entry.title)} <code>${entry.variant}</code></figcaption>
<div class="tile">${entry.html}</div>
</figure>`,
    );
    return `<section id="${component}">
<h2>${component}</h2>
${figures.join("\n")}
</section>`;
  });
  const body = `<main>
<h1>Components</h1>
<nav aria-label="Components"><ul>${nav.join("")}</ul></nav>
${sections.join("\n")}
<footer>Build: ${label} (<code>${sha}</code>)</footer>
</main>`;
  return htmlDocument("Hatchmark components", GALLERY_STYLE, body, head);
}

function notice(title: string, text: string): string {
  return htmlDocument(
    title,
    GALLERY_STYLE,
    `<main>
<h1>${escapeHtml(title)}</h1>
<p>${text}</p>
</main>`,
  );
}

/** Renders the static site as a map from path (relative to the site root) to file content. */
export function renderSite(input: SiteInput): Map<string, string> {
  return new Map([
    ["index.html", shell(input)],
    ["components/index.html", gallery(input)],
    ["404.html", notice("Not found", '<a href="/">Back to the preview</a>')],
  ]);
}

import { describe, expect, it } from "vitest";
import { entries, head } from "../src/entries.js";
import { buildLabel, renderSite, type SiteInput } from "../src/page.js";

const build = { pr: 12, sha: "1a5224b64c0ffee0000000000000000000000000" };
const empty: SiteInput = { entries: [], head: "", build };
const kpi = (variant: string, title = variant) => ({
  component: "kpi",
  variant,
  title,
  html: `<div class="kpi">${variant}</div>`,
});

describe("preview site", () => {
  it("registers the renderer's gallery entries", () => {
    expect(new Set(entries.map((e) => e.component))).toEqual(
      new Set(["kpi", "line", "bar", "table"]),
    );
    expect(renderSite({ entries, head, build }).get("components/index.html")).toContain(
      'class="hm-root"',
    );
  });

  it("shows an empty state with the build info", () => {
    const gallery = renderSite(empty).get("components/index.html") ?? "";
    expect(gallery).toContain("No components yet");
    expect(gallery).toContain("PR #12 · 1a5224b");
    expect(gallery).toContain(build.sha);
  });

  it("writes the shell, the gallery and a 404 page", () => {
    expect([...renderSite(empty).keys()]).toEqual([
      "index.html",
      "components/index.html",
      "404.html",
    ]);
  });

  it("is deterministic for the same input", () => {
    const input = { ...empty, entries: [kpi("plain"), kpi("with-delta")] };
    expect(renderSite(input)).toEqual(renderSite(input));
  });

  it("groups variants under their component in registration order", () => {
    const line = { component: "line", variant: "plain", title: "Plain", html: "<svg></svg>" };
    const gallery =
      renderSite({ ...empty, entries: [kpi("b"), line, kpi("a")] }).get("components/index.html") ??
      "";
    expect(gallery).not.toContain("No components yet");
    expect(gallery.indexOf('id="kpi--b"')).toBeLessThan(gallery.indexOf('id="kpi--a"'));
    expect(gallery.indexOf('id="kpi--a"')).toBeLessThan(gallery.indexOf('id="line"'));
  });

  it("escapes titles and inserts entry html as is", () => {
    const gallery =
      renderSite({ ...empty, entries: [kpi("plain", "<b>Revenue</b>")] }).get(
        "components/index.html",
      ) ?? "";
    expect(gallery).toContain("&lt;b&gt;Revenue&lt;/b&gt;");
    expect(gallery).toContain('<div class="kpi">plain</div>');
  });

  it("rejects duplicate and malformed ids", () => {
    expect(() => renderSite({ ...empty, entries: [kpi("a"), kpi("a")] })).toThrow(/twice/);
    expect(() => renderSite({ ...empty, entries: [kpi("Bad Id")] })).toThrow(/lowercase/);
  });

  it("frames the gallery and offers the theme and width toggles", () => {
    const shell = renderSite(empty).get("index.html") ?? "";
    expect(shell).toContain('<iframe id="frame" title="Preview" src="components/">');
    expect(shell).toContain('value="dark"');
    expect(shell).toContain('value="mobile"');
    expect(shell).toContain('value="dashboard"');
  });

  it("puts the head markup into the gallery", () => {
    const gallery = renderSite({ ...empty, head: '<link rel="stylesheet" href="theme.css">' }).get(
      "components/index.html",
    );
    expect(gallery).toContain('<link rel="stylesheet" href="theme.css">');
  });

  it("links the favicons on every page and shows the lockup in the shell header", () => {
    for (const [path, html] of renderSite(empty)) {
      expect(html, path).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml"');
      expect(html, path).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32">');
      expect(html, path).toContain(
        '<link rel="apple-touch-icon" href="/apple-touch-icon-180.png">',
      );
    }
    const shell = renderSite(empty).get("index.html") ?? "";
    expect(shell).toContain('src="/_brand/hatchmark-lockup-horizontal-light.svg" alt="Hatchmark"');
    expect(shell).toContain('src="/_brand/hatchmark-lockup-horizontal-dark.svg" alt="Hatchmark"');
  });

  it("labels main and local builds", () => {
    expect(buildLabel({ sha: build.sha })).toBe("main · 1a5224b");
    expect(buildLabel({})).toBe("local build");
  });
});

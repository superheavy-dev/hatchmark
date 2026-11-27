import { describe, expect, it } from "vitest";
import { entries } from "../src/entries.js";
import { buildLabel, renderPlaceholder, renderSite, type SiteInput } from "../src/page.js";

const build = { pr: 12, sha: "1a5224b64c0ffee0000000000000000000000000" };
const empty: SiteInput = { entries: [], head: "", build, dashboard: false };
const kpi = (variant: string, title = variant) => ({
  component: "kpi",
  variant,
  title,
  html: `<div class="kpi">${variant}</div>`,
});

describe("preview site", () => {
  it("ships no entries until the renderer registers some", () => {
    expect(entries).toEqual([]);
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

  it("offers the example dashboard only when it was built", () => {
    expect(renderSite(empty).get("index.html")).toContain("Example dashboard not built yet");
    const shell = renderSite({ ...empty, dashboard: true }).get("index.html") ?? "";
    expect(shell).toContain('href="dashboard/"');
    expect(shell).toContain("&quot;dashboard&quot;:&quot;dashboard/&quot;");
  });

  it("puts the head markup into the gallery", () => {
    const gallery = renderSite({ ...empty, head: '<link rel="stylesheet" href="theme.css">' }).get(
      "components/index.html",
    );
    expect(gallery).toContain('<link rel="stylesheet" href="theme.css">');
  });

  it("labels main and local builds", () => {
    expect(buildLabel({ sha: build.sha })).toBe("main · 1a5224b");
    expect(buildLabel({})).toBe("local build");
  });

  it("has a placeholder for production before main deploys", () => {
    expect(renderPlaceholder().get("index.html")).toContain("next push to main");
  });
});

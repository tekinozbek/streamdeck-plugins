import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NO_BODY } from "../src/http";

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "io.github.tekinozbek.api-tools.sdPlugin", "ui", "webhook.html"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

describe("property inspector", () => {
  const methods = [...(/<sdpi-select setting="method"[\s\S]*?<\/sdpi-select>/.exec(html)?.[0].matchAll(/<option>(\w+)<\/option>/g) ?? [])].map((m) => m[1]);

  it("offers every method including HEAD", () => {
    expect(methods).toEqual(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
  });
  it("lists exactly the pollable methods (GET/HEAD) as bodyless, consistent with the Help text", () => {
    expect([...NO_BODY].sort()).toEqual(["GET", "HEAD"]);
    expect(html).toMatch(/GET and HEAD only/);
    expect(html).toMatch(/Ignored for GET \/ HEAD/);
  });
  it("documents the Timeout limits in Help and README", () => {
    expect(html).toMatch(/1 to 120 seconds/);
    expect(html).toMatch(/Empty or <code>0<\/code> = 10 s/);
    expect(readme).toMatch(/1-120 seconds. Empty or `0` means 10 s/);
  });
  it("has balanced <details> tags", () => {
    expect((html.match(/<details/g) ?? []).length).toBe((html.match(/<\/details>/g) ?? []).length);
  });
});

describe("API Toggle property inspector and manifest", () => {
  const sd = path.join(root, "io.github.tekinozbek.api-tools.sdPlugin");
  const toggleHtml = fs.readFileSync(path.join(sd, "ui", "toggle.html"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(sd, "manifest.json"), "utf8"));
  const act = manifest.Actions.find((a: { UUID: string }) => a.UUID === "io.github.tekinozbek.api-tools.toggle");
  const settings = [...toggleHtml.matchAll(/setting="(\w+)"/g)].map((m) => m[1]);

  it("has balanced <details> tags", () => {
    expect((toggleHtml.match(/<details/g) ?? []).length).toBe((toggleHtml.match(/<\/details>/g) ?? []).length);
  });
  it("uses exactly the setting names the action reads", () => {
    expect(settings.sort()).toEqual(
      ["statusUrl", "statusHeaders", "pollMs", "timeout", "stateExpr", "onWhen",
       "offIconSource", "offIcon", "onIconSource", "onIcon",
       "onUrl", "onMethod", "onHeaders", "onBody", "offUrl", "offMethod", "offHeaders", "offBody"].sort(),
    );
  });
  it("is registered with two states and no automatic toggling", () => {
    expect(act.DisableAutomaticStates).toBe(true);
    expect(act.States).toHaveLength(2);
    expect(act.PropertyInspectorPath).toBe("ui/toggle.html");
  });
  it("ships every image the manifest and action need", () => {
    const names = ["icon", "off", "on", "unknown", "error"].flatMap((n) => [`${n}.png`, `${n}@2x.png`]);
    for (const n of names) expect(fs.existsSync(path.join(sd, "imgs", "actions", "toggle", n)), n).toBe(true);
  });
  it("warns that presses and polls send real requests", () => {
    expect(toggleHtml).toMatch(/Test with a harmless endpoint first/);
  });
});

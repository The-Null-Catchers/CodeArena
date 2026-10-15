import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dashboard = JSON.parse(
  readFileSync("infrastructure/monitoring/grafana/dashboards/codearena.json", "utf8"),
) as {
  panels: Array<{
    id: number;
    title: string;
    gridPos: { x: number; y: number; w: number; h: number };
    targets: Array<{ expr: string }>;
  }>;
};

describe("Grafana execution dashboard", () => {
  it("keeps panel identifiers unique and positions within the 24-column grid", () => {
    const ids = dashboard.panels.map((panel) => panel.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const panel of dashboard.panels) {
      expect(panel.gridPos.x).toBeGreaterThanOrEqual(0);
      expect(panel.gridPos.w).toBeGreaterThan(0);
      expect(panel.gridPos.x + panel.gridPos.w).toBeLessThanOrEqual(24);
      expect(panel.gridPos.y).toBeGreaterThanOrEqual(0);
      expect(panel.gridPos.h).toBeGreaterThan(0);
    }
  });

  it("has valid Prometheus expressions for each panel", () => {
    for (const panel of dashboard.panels) {
      expect(panel.targets.length).toBeGreaterThan(0);
      for (const target of panel.targets) {
        expect(target.expr.trim()).not.toBe("");
      }
    }
  });

  it("monitors durable scheduler dispatch backlog and failures", () => {
    const expressions = dashboard.panels.flatMap((panel) =>
      panel.targets.map((target) => target.expr),
    );
    expect(expressions).toContain("codearena_scheduler_outbox_backlog");
    expect(
      expressions.some((expression) =>
        expression.includes("codearena_scheduler_outbox_dispatch_total"),
      ),
    ).toBe(true);
  });
});

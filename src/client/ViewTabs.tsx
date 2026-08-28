// The Tests | Coverage switcher. Additive: the results view is still what the
// panel opens on, so every existing behaviour (and every existing e2e
// selector) is reached without touching this control.

export type ViewTab = "tests" | "coverage";

export function ViewTabs({ tab, onTab, coveragePercent, hasCoverage }: {
  tab: ViewTab;
  onTab: (t: ViewTab) => void;
  coveragePercent: number | null;
  hasCoverage: boolean;
}) {
  const btn = (value: ViewTab, label: string, badge?: string) => (
    <button
      type="button"
      class={"view-tab" + (tab === value ? " active" : "")}
      data-testid={"tab-" + value}
      aria-pressed={tab === value}
      onClick={() => onTab(value)}
    >
      {label}
      {badge != null && <span class="view-tab-badge">{badge}</span>}
    </button>
  );

  return (
    <div class="view-tabs" data-testid="view-tabs" role="group" aria-label="Switch between tests and coverage">
      {btn("tests", "Tests")}
      {btn("coverage", "Coverage", hasCoverage && coveragePercent != null ? coveragePercent + "%" : undefined)}
    </div>
  );
}

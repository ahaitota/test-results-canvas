// Shared result shape used across the parsers, server, and SDK actions.

export type TestStatus = "pass" | "fail" | "skip";

// One test outcome. The core four fields come from every source; the rest are
// enrichment the TRX/JUnit parsers add when the report carries them.
export interface TestResult {
  name: string;
  status: TestStatus;
  durationMs?: number;
  message?: string;
  className?: string;
  method?: string;
  suite?: string;
  framework?: string;
  adapter?: string;
  storage?: string;
  computerName?: string;
  startTime?: string;
  endTime?: string;
  // Which results file this row came from. Set only when several files are
  // merged into one run; a single-file run leaves it undefined.
  source?: string;
}

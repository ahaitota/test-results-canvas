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
  // Source file the test was declared in, as the runner spelled it (pytest,
  // jest-junit and friends put it on <testcase>). The one field that links a
  // test to a path without guessing, so diff mode uses it first; see
  // src/diff/relevance.ts.
  file?: string;
  framework?: string;
  adapter?: string;
  storage?: string;
  computerName?: string;
  startTime?: string;
  endTime?: string;
}

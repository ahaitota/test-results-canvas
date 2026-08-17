export type TestStatus = "pass" | "fail" | "skip";
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
    source?: string;
}

// TAP 13 (and TAP 14 subtests): node:test, prove, pytest-tap, tap.py, Catch2, ...
//
//   TAP version 13
//   1..2
//   ok 1 - adds
//   not ok 2 - subtracts
//     ---
//     duration_ms: 1.5
//     error: 'expected 1 got 2'
//     ...

import type { TestResult, TestStatus } from "../types.js";

const POINT = /^(not\s+)?ok\b[ \t]*(\d+)?[ \t]*(?:-[ \t]*)?(.*)$/;
const SUBTEST = /^#[ \t]*Subtest:[ \t]*(.*)$/;

interface Frame {
    indent: number;
    name: string;
}

// "name # SKIP reason" / "# TODO reason" -> the directive and what is left.
function directive(description: string): { status: TestStatus | null; reason?: string; name: string } {
    const hash = description.indexOf("#");
    if (hash < 0) return { status: null, name: description.trim() };
    const d = /^\s*(skip|todo)\b[ \t]*(.*)$/i.exec(description.slice(hash + 1));
    if (!d) return { status: null, name: description.trim() };
    return { status: "skip", reason: d[2].trim() || undefined, name: description.slice(0, hash).trim() };
}

// The YAML diagnostic block after a point: only the fields worth showing.
// Values are either inline (`error: 'boom'`) or a block scalar (`error: |-`)
// followed by lines indented deeper than the key -- which is what node:test
// emits for anything multi-line, so the block form carries most real failures.
function fromYaml(lines: string[]): { message?: string; durationMs?: number } {
    const found = new Map<string, string>();
    let durationMs: number | undefined;
    for (let i = 0; i < lines.length; i++) {
        const m = /^(\s*)(message|error|stack|duration_ms):\s*(.*)$/.exec(lines[i]);
        if (!m) continue;
        const indent = m[1].length;
        let value = m[3].trim();
        if (/^[|>][-+]?\d*$/.test(value)) {
            const block: string[] = [];
            while (i + 1 < lines.length && (!lines[i + 1].trim() || lines[i + 1].search(/\S/) > indent)) block.push(lines[++i]);
            const filled = block.filter((l) => l.trim());
            const strip = filled.length ? Math.min(...filled.map((l) => l.search(/\S/))) : 0;
            value = block.map((l) => l.slice(strip)).join("\n").trim();
        } else {
            value = value.replace(/^['"]|['"]$/g, "");
        }
        if (m[2] === "duration_ms") {
            const n = Number(value);
            if (Number.isFinite(n)) durationMs = Math.round(n);
        } else if (!found.has(m[2])) {
            found.set(m[2], value);
        }
    }
    const message = [found.get("error") ?? found.get("message"), found.get("stack")].filter(Boolean).join("\n");
    return { message: message || undefined, durationMs };
}

export function parseTap(text: string): TestResult[] {
    const out: TestResult[] = [];
    const stack: Frame[] = [];
    let yaml: string[] | null = null;
    let last: TestResult | undefined;

    for (const raw of String(text || "").split(/\r?\n/)) {
        const line = raw.trim();
        const indent = raw.length - raw.trimStart().length;
        if (yaml) {
            if (line === "...") {
                const { message, durationMs } = fromYaml(yaml);
                if (last) {
                    if (last.status === "fail") last.message = message ?? last.message;
                    last.durationMs = durationMs ?? last.durationMs;
                }
                yaml = null;
                continue;
            }
            yaml.push(raw);
            continue;
        }
        if (line === "---" && last) {
            yaml = [];
            continue;
        }
        const sub = SUBTEST.exec(line);
        if (sub) {
            stack.push({ indent, name: sub[1].trim() });
            continue;
        }
        const point = POINT.exec(line);
        if (!point) continue;
        // A subtest's own points are indented under it; its summary point sits
        // back at the parent's level and closes the frame.
        while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
        const { status: forced, reason, name } = directive(point[3] ?? "");
        const status: TestStatus = forced ?? (point[1] ? "fail" : "pass");
        last = {
            name: name || `test ${point[2] ?? out.length + 1}`,
            status,
            message: reason,
            suite: stack.length ? stack.map((f) => f.name).join(" > ") : undefined,
            framework: "TAP",
        };
        out.push(last);
    }
    return out;
}

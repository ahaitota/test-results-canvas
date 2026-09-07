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
const POINT = /^(not\s+)?ok\b[ \t]*(\d+)?[ \t]*(?:-[ \t]*)?(.*)$/;
const SUBTEST = /^#[ \t]*Subtest:[ \t]*(.*)$/;
const PLAN = /^(\d+)\.\.(\d+)/;
// "name # SKIP reason" / "# TODO reason" -> the directive and what is left.
function directive(description) {
    const hash = description.indexOf("#");
    if (hash < 0)
        return { status: null, name: description.trim() };
    const d = /^\s*(skip|todo)\b[ \t]*(.*)$/i.exec(description.slice(hash + 1));
    if (!d)
        return { status: null, name: description.trim() };
    return { status: "skip", reason: d[2].trim() || undefined, name: description.slice(0, hash).trim() };
}
// The YAML diagnostic block after a point: only the fields worth showing.
// Values are either inline (`error: 'boom'`) or a block scalar (`error: |-`)
// followed by lines indented deeper than the key -- which is what node:test
// emits for anything multi-line, so the block form carries most real failures.
function fromYaml(lines) {
    const found = new Map();
    let durationMs;
    for (let i = 0; i < lines.length; i++) {
        const m = /^(\s*)(message|error|stack|duration_ms):\s*(.*)$/.exec(lines[i]);
        if (!m)
            continue;
        const indent = m[1].length;
        let value = m[3].trim();
        if (/^[|>][-+]?\d*$/.test(value)) {
            const block = [];
            while (i + 1 < lines.length && (!lines[i + 1].trim() || lines[i + 1].search(/\S/) > indent))
                block.push(lines[++i]);
            const filled = block.filter((l) => l.trim());
            const strip = filled.length ? Math.min(...filled.map((l) => l.search(/\S/))) : 0;
            value = block.map((l) => l.slice(strip)).join("\n").trim();
        }
        else {
            value = value.replace(/^['"]|['"]$/g, "");
        }
        if (m[2] === "duration_ms") {
            const n = Number(value);
            if (Number.isFinite(n))
                durationMs = Math.round(n);
        }
        else if (!found.has(m[2])) {
            found.set(m[2], value);
        }
    }
    const message = [found.get("error") ?? found.get("message"), found.get("stack")].filter(Boolean).join("\n");
    return { message: message || undefined, durationMs };
}
// The row a scope owes when its points did not match its plan.
function planShortfall(frame, suite) {
    if (frame.planned === undefined || frame.planned === frame.seen)
        return null;
    return {
        name: "plan not satisfied",
        status: "fail",
        message: `TAP plan expected ${frame.planned} test${frame.planned === 1 ? "" : "s"}, saw ${frame.seen}`,
        suite,
        framework: "TAP",
    };
}
export function parseTap(text) {
    const out = [];
    // stack[0] is the stream itself; the rest are open subtests.
    const stack = [{ indent: -1, seen: 0 }];
    const suiteOf = () => {
        const names = stack.map((f) => f.name).filter(Boolean);
        return names.length ? names.join(" > ") : undefined;
    };
    // Reported by the bail out itself, so the plan it interrupted is not also
    // blamed for the tests that never ran.
    let bailed = false;
    let yaml = null;
    let last;
    // Close every scope the given indent has left, reporting each one's plan.
    const closeTop = () => {
        const suite = suiteOf();
        const short = planShortfall(stack.pop(), suite);
        if (short)
            out.push(short);
    };
    const popTo = (indent) => {
        while (stack.length > 1 && indent <= stack[stack.length - 1].indent)
            closeTop();
    };
    for (const raw of String(text || "").split(/\r?\n/)) {
        const line = raw.trim();
        const indent = raw.length - raw.trimStart().length;
        if (yaml) {
            if (line === "...") {
                const { message, durationMs } = fromYaml(yaml);
                if (last) {
                    if (last.status === "fail")
                        last.message = message ?? last.message;
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
            stack.push({ indent, name: sub[1].trim(), seen: 0 });
            continue;
        }
        // "Bail out!" abandons the run: everything after it is unreached, and a
        // run that stopped early is a failure however many points preceded it.
        const bail = /^Bail out!\s*(.*)$/i.exec(line);
        if (bail) {
            out.push({ name: "Bail out!", status: "fail", message: bail[1].trim() || undefined, suite: suiteOf(), framework: "TAP" });
            bailed = true;
            break;
        }
        // "1..N" belongs to the scope that is open where it appears; a subtest
        // writes its own, indented with its points.
        const plan = PLAN.exec(line);
        if (plan) {
            stack[stack.length - 1].planned = Number(plan[2]) - Number(plan[1]) + 1;
            continue;
        }
        const point = POINT.exec(line);
        if (!point)
            continue;
        // A subtest's own points are indented under it; its summary point sits
        // back at the parent's level and closes the frame.
        popTo(indent);
        stack[stack.length - 1].seen++;
        const { status: forced, reason, name } = directive(point[3] ?? "");
        const status = forced ?? (point[1] ? "fail" : "pass");
        last = {
            name: name || `test ${point[2] ?? out.length + 1}`,
            status,
            message: reason,
            suite: suiteOf(),
            framework: "TAP",
        };
        out.push(last);
    }
    if (!bailed) {
        while (stack.length)
            closeTop();
    }
    return out;
}
//# sourceMappingURL=tap.js.map
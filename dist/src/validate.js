// Narrows model-generated action/open input. The SDK validates it against the
// declared JSON schemas first, but the compiler only sees `unknown`.
// A non-empty string, or undefined for anything else.
export function asString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
// A finite number, or undefined. NaN/Infinity would render as "NaNms".
export function asNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
// One test result, or null. Only `name` is required; normalizeStatus() in the
// server already maps any unknown status onto pass/fail/skip.
export function asResultInput(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return null;
    const raw = value;
    const name = asString(raw.name);
    if (!name)
        return null;
    return { name, status: raw.status, durationMs: asNumber(raw.durationMs), message: asString(raw.message) };
}
// The most paths a single open/action may name. A merged run is a handful of
// test projects, not a filesystem crawl; the cap keeps one bad argument from
// turning into thousands of stat calls.
export const MAX_SOURCE_PATHS = 64;
// Non-empty strings from an array, deduped and capped. Anything that is not an
// array yields an empty list. Duplicates are dropped here rather than after
// path resolution so the cap counts real files, not repeats of one.
export function asStringArray(value, max = MAX_SOURCE_PATHS) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    const seen = new Set();
    for (const entry of value) {
        const s = asString(entry);
        if (!s || seen.has(s))
            continue;
        seen.add(s);
        out.push(s);
        if (out.length >= max)
            break;
    }
    return out;
}
// One test the agent believes the change affects. `name` is required -- without
// it there is nothing to match against -- while `className` only narrows the
// match and `reason` is what the badge's tooltip will say.
export function asAgentTestRef(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return null;
    const raw = value;
    const name = asString(raw.name);
    if (!name)
        return null;
    return { name, className: asString(raw.className), reason: asString(raw.reason) };
}
// The optional file/folder seeds from a canvas open input; `input` itself is
// optional, since opening with no input is legal. `resultsFiles` is the merged
// form; the singular fields are the original one-file API and keep working.
export function asOpenInput(input) {
    const resultsFiles = asStringArray(input?.resultsFiles);
    return {
        name: asString(input?.name),
        resultsFile: asString(input?.resultsFile),
        resultsDir: asString(input?.resultsDir),
        // Absent rather than empty, so a caller can tell "no list given" from
        // "a list that held nothing usable".
        resultsFiles: resultsFiles.length ? resultsFiles : undefined,
        coverageFile: asString(input?.coverageFile),
        coverageDir: asString(input?.coverageDir),
        projectRoot: asString(input?.projectRoot),
    };
}
// Input to the `open_files` action.
export function asFilesInput(input) {
    return { name: asString(input?.name), files: asStringArray(input?.files) };
}
//# sourceMappingURL=validate.js.map
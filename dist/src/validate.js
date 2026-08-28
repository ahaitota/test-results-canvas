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
// optional, since opening with no input is legal.
export function asOpenInput(input) {
    return {
        resultsFile: asString(input?.resultsFile),
        resultsDir: asString(input?.resultsDir),
        coverageFile: asString(input?.coverageFile),
        coverageDir: asString(input?.coverageDir),
        projectRoot: asString(input?.projectRoot),
    };
}
//# sourceMappingURL=validate.js.map
// Unique display labels for discovered result files, keyed back to their path.

import { basename, dirname } from "node:path";

// Prefer the bare filename; on a collision, prefix the parent folder, then a counter.
//   discovered: Map<label, absPath>   localNames: result files in the extension folder
export function labelForPath(abs, discovered, localNames = []) {
    for (const [label, p] of discovered) if (p === abs) return label;
    const name = basename(abs);
    const taken = (l) => discovered.has(l) || localNames.includes(l);
    if (!taken(name)) return name;
    const withParent = `${basename(dirname(abs))}/${name}`;
    if (!taken(withParent)) return withParent;
    let i = 2;
    while (taken(`${withParent} (${i})`)) i++;
    return `${withParent} (${i})`;
}

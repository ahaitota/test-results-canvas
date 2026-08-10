// Jump-to-failure: the n/p keyboard shortcuts and the "Next failure" button.
// Owns the row element registry, the cursor, and the scroll-and-flash effect.
import { useEffect, useRef, useState } from "preact/hooks";

export function useJumpToFailure(
  collapsedGroups: Set<string>,
  expandGroup: (key: string) => void,
  // Brings a row outside the rendered window into it.
  revealRow: (i: number) => void,
) {
  const rowRefs = useRef(new Map<number, HTMLElement>());
  const failingOrder = useRef<number[]>([]);
  const rowGroup = useRef(new Map<number, string>());
  const cursor = useRef(-1);
  const nonce = useRef(0);
  const [target, setTarget] = useState<{ i: number; nonce: number } | null>(null);
  const revealRef = useRef(revealRow);
  revealRef.current = revealRow;

  function jump(dir: number) {
    const order = failingOrder.current;
    if (!order.length) return;
    cursor.current = (cursor.current + dir + order.length) % order.length;
    const targetI = order[cursor.current];
    const gk = rowGroup.current.get(targetI);
    if (gk && collapsedGroups.has(gk)) expandGroup(gk);
    setTarget({ i: targetI, nonce: nonce.current++ });
  }
  // Kept in a ref so the keyboard listener always calls the current closure.
  const jumpRef = useRef(jump);
  jumpRef.current = jump;

  // Scroll the jumped-to row into view and flash it (imperative, like the
  // original). It is virtualized, so keep asking until it renders.
  useEffect(() => {
    if (!target) return;
    let frames = 0;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const el = rowRefs.current.get(target.i);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("flash");
        void el.offsetWidth;
        el.classList.add("flash");
        timer = setTimeout(() => el.classList.remove("flash"), 1100);
        return;
      }
      if (frames++ > 90) return;
      revealRef.current(target.i);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [target?.nonce]);

  // n = next failure, p = previous (ignored while typing in a control).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = ((e.target as HTMLElement)?.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "n") {
        e.preventDefault();
        jumpRef.current(1);
      } else if (e.key === "p") {
        e.preventDefault();
        jumpRef.current(-1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return {
    jump,
    // Registers each rendered row so the scroll effect can find it.
    setRowRef: (i: number) => (el: HTMLElement | null) => {
      if (el) rowRefs.current.set(i, el);
      else rowRefs.current.delete(i);
    },
    // Called during render with the current on-screen order.
    setNavigationOrder(failing: number[], groupOf: Map<number, string>) {
      failingOrder.current = failing;
      rowGroup.current = groupOf;
    },
    // The failing set may have changed, so restart from the top.
    resetCursor() {
      cursor.current = -1;
    },
    get failingCount() {
      return failingOrder.current.length;
    },
  };
}

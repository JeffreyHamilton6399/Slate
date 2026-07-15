---
Task ID: ROUND3-B
Agent: main (Z.ai Code)
Task: Fix bevel "rotating/swirling" behavior + CAD measurement label sizing

Work Log:
- Read /home/z/my-project/worklog.md (last entry was FIX-ROUND-2) and the two target files:
  - packages/mesh/src/ops.ts → bevelVerts (lines 191-329)
  - apps/client/src/viewport3d/SceneObjects.tsx → ElementHighlight & FaceHighlight

Task 1 — Bevel swirl fix (packages/mesh/src/ops.ts):
- Root cause confirmed: the corner-fill edge sort at lines 287-298 used a discontinuous
  tangent-basis seed — `Math.abs(n.x) < 0.9 ? {x:1,y:0,z:0} : {x:0,y:1,z:0}`. As the
  vertex normal crossed |n.x| = 0.9 during interactive dragging, the basis (u, w) flipped
  90°, which could change the atan2-based sort order in a non-cyclic way. Combined with
  the winding check (`edges.reverse()`), the final corner-fill could end up at a
  different cyclic rotation between edits — that's the "rotating kind of thing" the
  user reported.

- Fix: replaced the angle sort with a deterministic topological neighbour cycle.
  1. Added a new block (right after vertNormal computation, BEFORE the face-rewriting
     loop) that walks each ORIGINAL face containing `vi`, records the (prev, next)
     pair from the face's vertex array, and chains these pairs into a single cycle
     by following "next of one == prev of next" (each shared edge appears as "next"
     in one face and "prev" in its CCW neighbour).
  2. The cycle is stored in `vertNeighbourCycle: Map<number, number[]>` mapping
     `vi` → ordered list of neighbour vertex ids.
  3. Chain has a safety counter (pairs.length+1) and falls back to face-iteration
     order if it can't close (non-manifold / inconsistent winding).
  4. In the corner-fill loop, replaced the `edges.sort(...)` block with a
     cutsByNb map (neighbourId → outward cuts), then ordered the edges by the
     cycle. Falls back to map iteration order if cycle length ≠ cutsByNb size.
  5. Kept the winding safety net: `dot(faceNormal(m, { v: outerRing }), n) < 0 →
     edges.reverse()`. The topology gives a consistent cyclic order but may be
     globally inverted depending on which face started the chain — the winding
     check catches that.
  6. vertNormal is still computed (used only for the winding check, NOT for sort).
  7. Removed all references to `seed`, `u`, `w`, `atan2`, and the `c = vGet(m, vi)`
     used only for the sort.

Task 2 — CAD measurement labels (apps/client/src/viewport3d/SceneObjects.tsx):
- ElementHighlight edge labels (line 695-696): `text-[8px]` → `text-[7px]`,
  `px-1 py-0` → `px-0.5 py-0`, `distanceFactor={8}` → `distanceFactor={6}`.
- FaceHighlight edge labels (line 821-822): same changes.
- FaceHighlight area labels (line 829-830): same changes (smaller pill, no longer
  "primary callout" sizing). Updated the comment from "slightly larger pill so it
  reads as the primary callout" to "small pill so it doesn't dominate the callout"
  to match.
- Labels remain centered on the edge midpoint / face centroid via `<Html center>`
  (unchanged — already correct).

Verification:
- `cd /home/z/my-project/slate/packages/mesh && npx vitest run src/ops.test.ts` →
  33/33 tests pass (including 4 bevel tests: single-corner watertight, outward
  winding via recalculateNormals no-op, huge-amount clamp, multi-segment
  watertight, multi-segment edge bevel rounded geometry).
- `cd /home/z/my-project/slate/apps/client && npx tsc --noEmit` → 0 errors.
- Dev server log shows clean compile (Next.js 16.1.3, GET / 200).

Stage Summary:
- 2 files modified.
- All 33 mesh tests pass; TypeScript clean.
- Bevel: topological ordering is invariant under vertex-position edits, so the
  multi-segment quad strips no longer swirl while dragging the bevel width.
- CAD labels: smaller (text-[7px], px-0.5) and don't scale up as aggressively
  (distanceFactor 6) — they sit centered on the lines as requested.

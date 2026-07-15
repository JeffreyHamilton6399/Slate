# Task PARALLEL-B — Face CAD measurements + smaller numbers

## Scope
Add CAD measurement labels when FACES are selected in the 3D editor (previously only EDGES showed labels). Also: make all measurement numbers smaller, fix edge-length math to respect object rotation, and format units per the board's display setting (mm/cm/m/in/ft).

## Files modified
1. `apps/client/src/viewport3d/units.ts` — added `formatArea(m², unit)` helper.
2. `apps/client/src/viewport3d/SceneObjects.tsx` — biggest change:
   - Imported `formatLength`, `formatArea`, `LengthUnit`.
   - Added `unit?: LengthUnit` to `SceneObjectsProps` (default `'m'`); forwarded to `SceneMesh` → highlight components.
   - Added module-level `worldMatrix(t: Transform)` helper (composes `THREE.Matrix4` from position + Euler rotation + scale).
   - `ElementHighlight`: prop `scale` → `transform` + `unit`; length now computed via `Vector3.applyMatrix4(worldMatrix(transform))` then `distanceTo` (rotation-correct); label uses `formatLength(len, unit)`; pill `text-[9px] → text-[8px]` and `py-px → py-0`.
   - `FaceHighlight`: prop signature `{ data, faces }` → `{ data, faces, transform, unit }`. Still renders the translucent orange fill, plus now also:
     * Perimeter-edge length labels (one per edge, at local midpoint) using the same `Html` overlay pattern as `ElementHighlight`.
     * Face-area label at the face centroid (local vertex average). Area computed in world space by fan-triangulating and summing `0.5 * |cross(b-a, c-a)|`.
     * Area pill uses solid `bg-warn` + `font-semibold` to read as the primary callout; edges use `bg-warn/90` + `font-medium`.
3. `apps/client/src/viewport3d/Viewport3D.tsx` — passes `unit={units}` (from `useBoardUnits`) to `<SceneObjects>`.

## Verification
- `npx tsc --noEmit` (from `apps/client`) — clean, zero errors.
- No ESLint script configured in this Vite project; typecheck is the gate.
- Code paths verified by reading the full ElementHighlight/FaceHighlight/SceneMesh call sites and confirming the `unit` plumbing threads from `useBoardUnits(room)` (sync/useBoardSettings.ts) → Viewport3D → SceneObjects → SceneMesh → ElementHighlight/FaceHighlight.

## Notes for downstream agents
- The label `<Html>` overlays are parented under the mesh `<group>`, so POSITION coords stay in mesh-local space; only the LENGTH/AREA math is projected to world space via `worldMatrix(transform)`. This is intentional — keeps labels glued to the geometry as the object moves.
- `formatArea` does NOT split ft into ft+in (just `ft²`); only `formatLength` does the `ft′ in″` split. Matches how the rest of the codebase treats areas (PropertiesPanel Size readout uses `formatLength` per-axis, no area splitting).
- The shared `worldMatrix` helper duplicates the composition pattern in `scene.ts:bakeMeshToWorld`; kept local to SceneObjects.tsx to avoid a cross-module import for a 7-line helper. If a third caller appears, refactor to `units.ts` or a new `transform.ts`.

---
name: BigBlock automation nodes
description: Custom React Flow node type that renders as a large colored card; how to add visual metadata to node data; palette design pattern.
---

## Rule
When working on the automation editor, use the `bigBlock` custom node type — NOT the ReactFlow built-in `"default"` type.

## How it works
- `BigBlockNode` is a custom React Flow node defined at module scope (not inside a component).
- `NODE_TYPES = { bigBlock: BigBlockNode }` is also at module scope — this is required to avoid React Flow re-render warnings from a new object reference on every render.
- Every node must have `icon`, `color`, `category`, and `description` baked into `node.data` at creation/load time (from the catalog lookup). `BigBlockNode` reads these from `data` directly — it does NOT look up the catalog at render time.
- The palette cards use the same `color` (Tailwind bg-* class) and `icon` as the canvas node, so palette items ARE the nodes visually.

## Category color map
```
triggers/trigger → bg-blue-600
crm → bg-emerald-600
messaging/comm → bg-violet-600
documents → bg-orange-500
ai → bg-pink-500
logic → bg-slate-500
scripts → bg-amber-500
data → bg-teal-600
io → bg-cyan-600
utility → bg-gray-500
integrations → bg-indigo-600
```

## Why
The user explicitly asked: "I want to be able to use the big blocks as automation nodes as well — not a single block. Big blocks first." The old design used `type: "default"` with JSX injected into `data.label` as a hack. The new design uses a proper custom node type — cleaner, more maintainable, and visually consistent between the palette and the canvas.

## How to apply
- When adding new node types to the catalog, they will automatically get the right color from `catColor(category)`.
- When loading saved graphs (which may have `type: "default"` from old saves), remap to `type: "bigBlock"` and bake catalog metadata into `data` in the `useEffect` load path.
- `buildGraphForSave()` outputs `type: n.data?.nodeType` (the catalog type, not "bigBlock") so the API/executor always sees the correct catalog type.

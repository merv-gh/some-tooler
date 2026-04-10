# Math Theory Map — Number Theory

## TASK-01: Create MathNode type and data structures
Define TypeScript types for the math knowledge graph: nodes (axioms, lemmas, theorems, terms, conjectures), edges (dependencies), and their positions/categories.

### Test Hint
- MathNode type has id, label, type (axiom|lemma|theorem|term|conjecture), description
- MathEdge type has source, target, label, type (uses|proves|depends)
- createNode() and createEdge() factory functions work correctly
- Node types are distinguishable and have correct defaults

### Implementation Hint
Simple TypeScript types and factory functions. No React yet. Keep types strict — use discriminated unions where possible. Types: axiom (leftmost), term (left), lemma (middle), theorem (right), conjecture (rightmost).

### Files
- test: src/__tests__/math-types.test.ts
- source: src/lib/math-types.ts

## TASK-02: Create Number Theory dataset
Build the actual Number Theory knowledge graph data — Peano axioms, fundamental theorem of arithmetic, prime number theorem, terms like prime/composite/divisibility, key lemmas, and unresolved conjectures.

### Test Hint
- numberTheoryGraph() returns a graph with nodes and edges
- Contains Peano axioms (at least 4)
- Contains terms: prime, composite, divisibility, congruence, modular arithmetic
- Contains theorems: FTA, PNT, Euclid's theorem (infinite primes)
- Contains conjectures: Goldbach, twin prime, Riemann hypothesis
- All edges reference valid node IDs
- Axioms have type 'axiom', theorems have type 'theorem', etc.

### Implementation Hint
Return a static dataset. Each node gets a unique string ID. Edges connect dependencies — e.g., FTA depends on prime definition and Euclid's lemma. Conjectures should reference the terms/theorems they build on.

### Files
- test: src/__tests__/number-theory-data.test.ts
- source: src/lib/number-theory-data.ts
- modify: src/lib/math-types.ts

## TASK-03: Layout engine — compute node positions
Given a graph, compute x/y positions for each node. X-axis = category depth (axioms left → conjectures right). Y-axis = spread nodes vertically within each category. Return a positioned graph.

### Test Hint
- layoutGraph() takes a MathGraph and returns nodes with x, y coordinates
- Axioms are positioned at x=0 (leftmost)
- Terms are positioned at x=1
- Lemmas at x=2
- Theorems at x=3
- Conjectures at x=4
- Nodes within same category are spread vertically (different y values)
- All nodes get valid numeric coordinates

### Implementation Hint
Simple column-based layout. Map node type to x column. Within each column, distribute nodes evenly on y-axis. Return a Map<nodeId, {x, y}> or augment nodes with position data.

### Files
- test: src/__tests__/layout-engine.test.ts
- source: src/lib/layout-engine.ts

## TASK-04: MathNodeCard component
React component that renders a single math node as a card. Shows label, type badge, and description on hover/expand. Color-coded by type.

### Test Hint
- Renders node label text
- Shows type badge (e.g., "axiom", "theorem")
- Has correct CSS class or data-attribute for node type
- Renders description when expanded/hovered
- Accepts onClick handler
- Applies different visual styles per node type

### Implementation Hint
Use shadcn Card component. Color mapping: axiom=blue, term=gray, lemma=amber, theorem=green, conjecture=purple. Keep it a pure presentational component — receives node data as props.

### Files
- test: src/__tests__/MathNodeCard.test.tsx
- source: src/components/MathNodeCard.tsx

## TASK-05: EdgeLine SVG component
React component that draws an SVG line/path between two positioned points, with an optional label. Curved bezier paths for visual clarity.

### Test Hint
- Renders an SVG path element
- Path connects from source position to target position
- Renders label text if provided
- Accepts sourcePos {x,y} and targetPos {x,y} props
- SVG path has correct bezier control points (horizontal curve)

### Implementation Hint
SVG <path> with cubic bezier. Control points offset horizontally for smooth left-to-right curves. Label positioned at midpoint. Use muted colors — edges should not dominate visually.

### Files
- test: src/__tests__/EdgeLine.test.tsx
- source: src/components/EdgeLine.tsx

## TASK-06: VerticalList sidebar component
Labelled vertical list on the left side showing all categories with their nodes. Each category is a collapsible section. Clicking a node highlights it on the map.

### Test Hint
- Renders category headers: Axioms, Terms, Lemmas, Theorems, Conjectures
- Lists nodes under correct category
- Clicking a node calls onSelectNode with node ID
- Selected node has visual highlight
- Categories are collapsible

### Implementation Hint
Use shadcn Collapsible or Accordion. Group nodes by type. Pass selectedNodeId and onSelectNode props. Keep it a controlled component.

### Files
- test: src/__tests__/VerticalList.test.tsx
- source: src/components/VerticalList.tsx

## TASK-07: GraphCanvas — main map component
Combines EdgeLines and MathNodeCards into a pannable, zoomable canvas. Positions nodes according to layout engine. Renders edges as SVG behind nodes.

### Test Hint
- Renders all nodes from graph data
- Renders all edges from graph data
- Nodes are positioned according to layout (style.left/top or transform)
- Clicking a node selects it (state management)
- Selected node is visually highlighted
- Canvas has a container with overflow handling

### Implementation Hint
Outer div with relative positioning. SVG layer for edges (absolute, behind). Div layer for node cards (absolute positioned). Use the layout engine to compute positions. Scale positions to pixel coordinates. Simple CSS transform for pan/zoom later.

### Files
- test: src/__tests__/GraphCanvas.test.tsx
- source: src/components/GraphCanvas.tsx

## TASK-08: App integration — wire sidebar + canvas
Main App component that loads Number Theory data, computes layout, and renders VerticalList + GraphCanvas side by side. Selection state syncs between them.

### Test Hint
- App renders without crashing
- Shows the vertical list sidebar
- Shows the graph canvas
- Selecting a node in sidebar highlights it on canvas
- Selecting a node on canvas highlights it in sidebar
- Title "Number Theory" is displayed

### Implementation Hint
Use React useState for selectedNodeId. Load data from number-theory-data module. Compute layout once. Pass selection state to both VerticalList and GraphCanvas. Use flex layout: sidebar fixed width, canvas fills remaining space.

### Files
- test: src/__tests__/App.test.tsx
- source: src/App.tsx
- modify: src/components/GraphCanvas.tsx
- modify: src/components/VerticalList.tsx

## TASK-09: Expand-to-right interaction
When a node in the vertical list is clicked, the map should smoothly scroll/pan to center that node's position and expand its connections.

### Test Hint
- Clicking a node in sidebar triggers scroll to node position on canvas
- Connected edges are highlighted when a node is selected
- Unconnected nodes are visually dimmed
- Selection can be cleared by clicking empty canvas area

### Implementation Hint
Track selectedNodeId in state. In GraphCanvas, when selectedNodeId changes, compute scroll offset to center that node. Add CSS transitions for smooth movement. Filter/highlight edges where source or target matches selected node.

### Files
- test: src/__tests__/interactions.test.tsx
- source: src/components/GraphCanvas.tsx
- modify: src/App.tsx

## TASK-10: Visual polish — colors, typography, responsive
Apply consistent design tokens, improve typography, add subtle animations, ensure the layout works on different screen sizes.

### Test Hint
- App renders at 1280x720 without horizontal overflow
- App renders at 1920x1080 without layout issues
- Node cards have consistent border radius and shadow
- Edge lines have appropriate opacity
- Category headers in sidebar have distinct styling

### Implementation Hint
Use Tailwind/shadcn design tokens. Add subtle hover effects on cards. Edge opacity 0.3 default, 0.8 when connected to selected node. Responsive: sidebar collapses on small screens. Add a header bar with title.

### Files
- test: src/__tests__/visual-polish.test.tsx
- source: src/components/MathNodeCard.tsx
- modify: src/components/GraphCanvas.tsx
- modify: src/components/VerticalList.tsx
- modify: src/App.tsx

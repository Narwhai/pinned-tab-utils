# Pinned Tab Utils — Obsidian Community Plugin

## Project overview

Automatically moves pinned tabs to the left side of the tab bar, mimicking browser behaviour. When a tab is pinned, it slides to the rightmost position among existing pinned tabs (just before the first unpinned tab). When unpinned, it slides to the leftmost unpinned position (just after the last pinned tab). The relative order of pinned tabs among themselves, and of unpinned tabs among themselves, is always preserved.

- Plugin ID: `pinned-tab-utils`
- Entry point: `src/main.ts` compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`.
- No settings, no styles.css, no user configuration.

## Architecture

### How it works

The plugin uses **targeted internal-API manipulation** to reorder tabs in-place without rebuilding the workspace. This preserves editor state (scroll position, cursor, undo history, selections).

1. **Pin-change detection** — Uses the public `leaf.on("pinned-change")` event (stable since Obsidian API) to detect when a tab is pinned or unpinned. New leaves are observed via a debounced scan triggered by `layout-change` events (200ms debounce to avoid redundant iteration on rapid-fire events like tab switches and resizes).

2. **Tab group discovery** — Uses the public `leaf.parent` property (typed as `WorkspaceTabs | WorkspaceMobileDrawer`) with an `instanceof WorkspaceTabs` check to find tab groups. This avoids walking the internal tree and automatically covers all areas: main workspace, popout windows, sidebars, and floating panes.
   - **Targeted reorder**: On `pinned-change`, only the affected leaf's parent tab group is reordered via `leaf.parent`.
   - **Full reorder**: On initial load or layout changes, all unique tab groups are collected by iterating all leaves via `iterateAllLeaves()` and deduplicating parents.

3. **Internal state reordering** — The `children` array on the tab group (internal API) is spliced in-place (not replaced) so existing Obsidian references like `activeLeaf` remain valid.

4. **DOM and internal state sync** — Four things must be kept in sync after reordering `children`:
   - **`tabHeaderEls` array** — Obsidian tracks tab header DOM references in `tabGroup.tabHeaderEls`. This array is rebuilt to match the sorted `children` order. If stale, `updateTabDisplay` will remove tabs that aren't in its set from the DOM.
   - **`currentTab` index** — Obsidian tracks the active tab's index in `tabGroup.currentTab`. The active leaf reference is saved **before** the reorder, then its new index is found with `indexOf` after sorting. If stale, clicking the tab at the old index will be a no-op.
   - **Tab headers inside `tabsInnerEl`** — Tab headers are re-appended to `tabGroup.tabsInnerEl` (`.workspace-tab-header-container-inner`) in sorted order. **Critical**: They must go into `tabsInnerEl`, not the outer `.workspace-tab-header-container`. Placing them outside breaks `updateTabDisplay` and causes tabs to vanish.
   - **Leaf containers** — Leaf container elements (`leaf.containerEl`) are re-appended to the `.workspace-tab-container` div in sorted order.

5. **`updateTabDisplay()` call** — After syncing everything, `tabGroup.updateTabDisplay()` is called to let Obsidian refresh its internal display state (widths, visibility, etc.).

### Re-entry guard

`layout-change` events fire when the DOM is reordered, which would trigger another reorder pass. An `isReordering` flag prevents infinite loops. It's set synchronously before DOM manipulation and cleared via `requestAnimationFrame` so that layout-change events triggered by our own DOM mutations are skipped.

### Short-circuit optimization

Before doing any reorder work, the plugin performs a quick O(n) scan: it walks each tab group's `children` array looking for a pinned tab that appears after an unpinned tab. If no such case exists, the entire reorder pass is skipped with no DOM or state changes.

### Key API usage

**Public API** (stable, documented):

| API | Description |
|---|---|
| `leaf.on("pinned-change")` | Detects pin/unpin events |
| `leaf.parent` | Gets the containing `WorkspaceTabs` or `WorkspaceMobileDrawer` |
| `instanceof WorkspaceTabs` | Type-checks that the parent is a tab group (not a mobile drawer) |
| `workspace.iterateAllLeaves()` | Iterates all leaves including popouts and sidebars |
| `workspace.on("layout-change")` | Detects structural workspace changes |
| `workspace.onLayoutReady()` | Runs callback when layout is ready |

**Internal API** (not public, but stable since Obsidian 1.0):

| Property | Type | Description |
|---|---|---|
| `tabGroup.children` | `InternalLeaf[]` | Leaves in a tab group; spliced in-place during reorder |
| `tabGroup.tabHeaderEls` | `HTMLElement[]` | Obsidian's tracked array of tab-header DOM refs; rebuilt to match sorted order |
| `tabGroup.currentTab` | `number` | Index of the active tab in `children`; updated after reorder |
| `tabGroup.tabsInnerEl` | `HTMLElement` | The `.workspace-tab-header-container-inner` div; actual parent of tab header elements |
| `tabGroup.containerEl` | `HTMLElement` | Tab group's root DOM element; used to find `.workspace-tab-container` |
| `tabGroup.updateTabDisplay()` | `function` | Re-renders tabs based on `tabHeaderEls` and `children` |
| `leaf.pinned` | `boolean` | Whether the leaf/tab is pinned |
| `leaf.tabHeaderEl` | `HTMLElement` | The `.workspace-tab-header` DOM element for the tab |
| `leaf.containerEl` | `HTMLElement` | The `.workspace-leaf` DOM element for the tab content |

### DOM structure of tab header container

```
.workspace-tab-header-container              (flex row, outer container)
├── .workspace-tab-header-container-inner    (flex row, scrollable — TABS LIVE HERE)
│   ├── .workspace-tab-header                ← pinned tab header
│   ├── .workspace-tab-header                ← pinned tab header
│   ├── .workspace-tab-header                ← unpinned tab header
│   ├── ...
│   └── .workspace-tab-header                ← unpinned tab header
├── .workspace-tab-header-spacer             (flex-grow:1 — pushes right-side controls)
├── .workspace-tab-header-tab-list            (dropdown arrow)
└── .workspace-tab-header-new-tab             (+ button)
```

**Critical**: Tab headers live inside `tabsInnerEl` (`.workspace-tab-header-container-inner`), not the outer `.workspace-tab-header-container`. They must be appended to `tabsInnerEl`. Putting them in the outer container breaks `updateTabDisplay` (which uses `setChildrenInPlace` on `tabsInnerEl`) and causes tabs to vanish.

## Environment & tooling

- Node.js 18+, npm, esbuild.
- Types: `obsidian` type definitions (latest).

### Install

```bash
npm install
```

### Dev (watch)

```bash
npm run dev
```

### Production build

```bash
npm run build
```

## Linting

- To use eslint install eslint from terminal: `npm install -g eslint`
- To use eslint to analyze this project use this command: `eslint main.ts`
- eslint will then create a report with suggestions for code improvement by file and line number.
- If your source code is in a folder, such as `src`, you can use eslint with this command to analyze all files in that folder: `eslint ./src/`

## File & folder conventions

```
src/
  main.ts           # Complete plugin — leaf observation, in-place reordering, DOM sync
```

No settings module — this plugin has no user configuration.

## Testing

- Reload the plugin after code changes: `obsidian plugin:reload id=pinned-tab-utils`
- Check for errors: `obsidian dev:errors`
- Visually verify: `obsidian dev:screenshot path=screenshot.png`
- Inspect internal state: `obsidian eval code="app.workspace.rootSplit.children[0].children.map(l => ({pinned: l.pinned, title: l.tabHeaderEl?.getAttribute('aria-label')}))"`
- The plugin works with split panes — each tab group in the workspace tree is sorted independently.
- Test with popout windows — tabs in popout windows should also be reordered.

## Commands

| Command ID | Name | Description |
|---|---|---|
| `reorder-pinned-tabs` | Reorder pinned tabs | Manually trigger a reorder pass (safety-net for edge cases) |

## Known constraints

- **Internal API reliance**: Uses `tabGroup.children`, `tabHeaderEls`, `tabsInnerEl`, `currentTab`, and `updateTabDisplay()` — none of which are part of the public Obsidian API. These have been stable since Obsidian 1.0 but could change in future versions.
- **No `is-pinned` CSS class**: Obsidian does not add `is-pinned` to tab header DOM elements when a tab is pinned — the state is purely tracked in `leaf.pinned`. A `MutationObserver` on class changes will not work for detecting pin state changes.
- **`tabsInnerEl` is the parent of tab headers**: Tab headers live inside `tabGroup.tabsInnerEl` (`.workspace-tab-header-container-inner`), not the outer `.workspace-tab-header-container`. Obsidian's `updateTabDisplay` calls `tabsInnerEl.setChildrenInPlace(...)`, so any tab headers placed outside `tabsInnerEl` will be removed during the next update.
- **Plugin conflicts**: Other plugins that also reorder tabs or manipulate tab group children may conflict.
- **Mobile**: On mobile, `leaf.parent` may be a `WorkspaceMobileDrawer` instead of `WorkspaceTabs`. The plugin skips these leaves via `instanceof WorkspaceTabs` check.

## Troubleshooting

- **Pinned tabs not moving**: Check that the plugin is enabled and loaded. Use `obsidian dev:console level=error` to look for errors. Try the manual "Reorder pinned tabs" command.
- **Large gap to the left of tabs**: Tab headers were placed in the outer `.workspace-tab-header-container` instead of inside `.workspace-tab-header-container-inner` (`tabsInnerEl`). See the architecture section above.
- **Tabs disappearing from the tab bar**: `tabGroup.tabHeaderEls` got out of sync with `tabGroup.children`. The reorder must rebuild `tabHeaderEls` to match the sorted order, otherwise `updateTabDisplay` removes "unexpected" tabs from the DOM.
- **Tabs shrinking after pinning**: Same root cause — tab headers placed outside `tabsInnerEl`, or `tabHeaderEls`/`currentTab` out of sync, causes `updateTabDisplay` to miscalculate widths.
- **Clicks not registering after pin**: `tabGroup.currentTab` went stale after the reorder. The active leaf moved to a different index but `currentTab` still pointed at the old one. The fix saves the leaf reference before reordering and finds its new index after.
- **Plugin conflicts**: Other plugins that also reorder tabs or manipulate tab group children may conflict.

## References

- Obsidian API documentation: https://docs.obsidian.md
- Obsidian API type definitions: ~/Repos/obsidian-api/obsidian.d.ts
- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines

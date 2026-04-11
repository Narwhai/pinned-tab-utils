# Pinned Tab Utils — Obsidian Community Plugin

## Project overview

Automatically moves pinned tabs to the left side of the tab bar, mimicking browser behaviour. When a tab is pinned, it slides to the rightmost position among existing pinned tabs (just before the first unpinned tab). When unpinned, it slides to the leftmost unpinned position (just after the last pinned tab). The relative order of pinned tabs among themselves, and of unpinned tabs among themselves, is always preserved.

- Plugin ID: `pinned-tab-utils`
- Entry point: `src/main.ts` compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`.
- No settings, no styles.css, no user configuration.

## Architecture

### How it works

The plugin has three layers that must stay in sync:

1. **Method patching** — Obsidian provides no event for pin/unpin state changes. The pin state is tracked purely in the internal `leaf.pinned` property (no DOM class or attribute changes). To detect pin/unpin, the plugin monkey-patches `WorkspaceLeaf.prototype.togglePinned` and `setPinned`, calling `scheduleReorder()` after the original method runs. The original methods are saved and restored on unload.

2. **Internal state reordering** — Walks the `WorkspaceRoot.children` tree (internal API, not public). A "tab group" is identified as a parent node whose children are all leaves (no nested splits). The `children` array is spliced in-place (not replaced) so existing Obsidian references like `activeLeaf` remain valid.

3. **DOM reordering** — Three things must be kept in sync. If any gets out of sync, `updateTabDisplay` will destroy the reorder or tabs will vanish from the tab bar:
   - **`tabHeaderEls` array** — Obsidian tracks tab header DOM references in `tabGroup.tabHeaderEls`. This array must be rewritten to match the sorted order. If it's stale, `updateTabDisplay` will remove tabs that aren't in its set from the DOM.
   - **`currentTab` index** — Obsidian tracks the active tab's index in `tabGroup.currentTab`. When our reorder changes the position of the active tab, `currentTab` must be updated to point to the same leaf at its new index. If it's stale, clicking the tab at the old index will be a no-op (Obsidian's `selectTabIndex` skips activation when `currentTab === index`), and clicking other tabs may activate the wrong one. The fix grabs the active leaf reference from `children[currentTab]` **before** the reorder, then does `indexOf` on the sorted array after.
   - **Tab headers inside `tabsInnerEl`** — Tab headers live inside the `.workspace-tab-header-container-inner` div (`tabGroup.tabsInnerEl`), **not** directly inside `.workspace-tab-header-container`. **Do not insert tab headers into the outer container** — they must be appended to `tabsInnerEl`. Placing them outside this inner container breaks Obsidian's flex layout and `updateTabDisplay`.
   - **Leaf containers** (`.workspace-tab-container`) — Leaf container elements can be appended normally.

### Re-entry guard

`layout-change` events fire when the DOM is reordered, which would trigger another reorder pass. An `isReordering` flag prevents infinite loops. It's set synchronously and cleared via `requestAnimationFrame` so that layout-change events triggered by our own DOM mutations are skipped.

### Key internal API details

These are not part of the public Obsidian API but are stable internal properties the plugin relies on:

| Property | Type | Description |
|---|---|---|
| `app.workspace.rootSplit` | `any` | Root of the workspace tree; traversed recursively to find tab groups |
| `rootSplit.children[n].children` | `any[]` | Leaves in a tab group; spliced in-place during reorder |
| `rootSplit.children[n].containerEl` | `HTMLElement` | Tab group's root DOM element |
| `leaf.pinned` | `boolean` | Whether the leaf/tab is pinned |
| `leaf.tabHeaderEl` | `HTMLElement` | The `.workspace-tab-header` DOM element for the tab |
| `leaf.containerEl` | `HTMLElement` | The `.workspace-leaf` DOM element for the tab content |
| `tabGroup.tabHeaderEls` | `HTMLElement[]` | Obsidian's tracked array of tab-header DOM refs; must be kept in sync with `children` order |
| `tabGroup.currentTab` | `number` | Index of the active tab in `children`; must be updated after reorder so clicks register correctly |
| `tabGroup.tabsInnerEl` | `HTMLElement` | The `.workspace-tab-header-container-inner` div; the actual parent of tab header elements |
| `tabGroup.updateTabDisplay()` | `function` | Re-renders tabs based on `tabHeaderEls` and `children`; calls `setChildrenInPlace` on `tabsInnerEl` |

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
  main.ts           # Complete plugin — method patching, tree walking, DOM reordering
```

No settings module — this plugin has no user configuration.

## Testing

- Reload the plugin after code changes: `obsidian plugin:reload id=pinned-tab-utils`
- Check for errors: `obsidian dev:errors`
- Visually verify: `obsidian dev:screenshot path=screenshot.png`
- Inspect internal state: `obsidian eval code="app.workspace.rootSplit.children[0].children.map(l => ({pinned: l.pinned, title: l.tabHeaderEl?.getAttribute('aria-label')}))"`
- The plugin works with split panes — each tab group in the workspace tree is sorted independently.

## Commands

| Command ID | Name | Description |
|---|---|---|
| `reorder-pinned-tabs` | Reorder pinned tabs | Manually trigger a reorder pass (safety-net for edge cases) |

## Known constraints

- **Internal API reliance**: Uses `app.workspace.rootSplit` and its `.children` tree, which is not part of the public Obsidian API. These have been stable since Obsidian 1.0 but could change in future versions.
- **Monkey-patching**: `WorkspaceLeaf.prototype.togglePinned` and `setPinned` are patched. These are the only Obsidian-internal methods that change pin state. If another plugin or future Obsidian version adds a different pin code path, a new patch may be needed.
- **No `is-pinned` CSS class**: Obsidian does not add `is-pinned` to tab header DOM elements when a tab is pinned — the state is purely tracked in `leaf.pinned`. A `MutationObserver` on class changes will not work for detecting pin state changes.
- **Internal `tabHeaderEls` array**: `tabGroup.tabHeaderEls` is Obsidian's tracked array of tab-header DOM elements. It must be rewritten to match the sorted `children` order. If it goes stale, `updateTabDisplay` will remove rearranged tabs from the DOM because it sees them as "not in the set" of expected elements.
- **`currentTab` index**: `tabGroup.currentTab` tracks the index of the active tab. After reorder, the active leaf may be at a different index. If `currentTab` is not updated, clicking the tab at the stale index will be ignored (Obsidian's `selectTabIndex` skips when `currentTab === index`), or clicking another tab may activate the wrong one. The fix saves `children[currentTab]` before reorder and finds its new index after.
- **`tabsInnerEl` is the parent of tab headers**: Tab headers live inside `tabGroup.tabsInnerEl` (`.workspace-tab-header-container-inner`), not the outer `.workspace-tab-header-container`. Obsidian's `updateTabDisplay` calls `tabsInnerEl.setChildrenInPlace(...)`, so any tab headers placed outside `tabsInnerEl` will be removed during the next update. Putting tab headers in the outer container also causes a visible gap on the left side of the tab bar.
- **The `+` new-tab button**: The `.workspace-tab-header-new-tab` button lives inside `.workspace-tab-header-container` (the outer container) and is not reordered — it stays at the far right naturally.

## Troubleshooting

- **Pinned tabs not moving**: Check that the plugin is enabled and loaded. Use `obsidian dev:console level=error` to look for errors. Try the manual "Reorder pinned tabs" command.
- **Large gap to the left of tabs**: Tab headers were placed in the outer `.workspace-tab-header-container` instead of inside `.workspace-tab-header-container-inner` (`tabsInnerEl`). See the architecture section above.
- **Tabs disappearing from the tab bar**: `tabGroup.tabHeaderEls` got out of sync with `tabGroup.children`. The reorder must rewrite `tabHeaderEls` to match the sorted order, otherwise `updateTabDisplay` removes "unexpected" tabs from the DOM.
- **Tabs shrinking after pinning**: Same root cause — tab headers placed outside `tabsInnerEl`, or `tabHeaderEls`/`currentTab` out of sync, causes `updateTabDisplay` to miscalculate widths.
- **Clicks not registering after pin**: `tabGroup.currentTab` went stale after the reorder. The active leaf moved to a different index but `currentTab` still pointed at the old one. The fix saves the leaf reference before reordering and finds its new index after.
- **Plugin conflicts**: Other plugins that also reorder tabs or patch `togglePinned`/`setPinned` may conflict.

## References

- Obsidian API documentation: https://docs.obsidian.md
- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines

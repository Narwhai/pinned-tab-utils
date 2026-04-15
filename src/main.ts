import { Plugin, WorkspaceLeaf } from "obsidian";

/**
 * Internal Obsidian types — not part of the public API but stable since 1.0.
 * Used for targeted, non-destructive tab reordering.
 */

interface InternalLeaf extends WorkspaceLeaf {
	pinned: boolean;
	tabHeaderEl: HTMLElement;
	containerEl: HTMLElement;
}

interface InternalTabGroup {
	children: InternalLeaf[];
	tabHeaderEls: HTMLElement[];
	currentTab: number;
	tabsInnerEl: HTMLElement;
	containerEl: HTMLElement;
	updateTabDisplay(): void;
}

interface InternalSplitNode {
	children: (InternalTabGroup | InternalSplitNode)[];
	type?: string;
}

/**
 * Pinned Tab Utils — automatically moves pinned tabs to the left side of
 * the tab bar, mimicking browser behaviour.
 *
 * Uses targeted internal-API manipulation to reorder tabs in-place:
 * - Detects pin changes via `leaf.on("pinned-change")`
 * - Walks `workspace.rootSplit` to find tab groups
 * - Splices `children[]` in-place, syncs `tabHeaderEls`, `currentTab`,
 *   and DOM nodes inside `tabsInnerEl`
 *
 * This preserves editor state (scroll position, cursor, undo history,
 * selections) because the workspace is never torn down and rebuilt.
 */
export default class PinnedTabUtilsPlugin extends Plugin {
	private observedLeaves = new WeakSet<WorkspaceLeaf>();
	private reorderScheduled = false;
	private isReordering = false;
	private observeDebounceTimer: number | null = null;

	async onload() {
		this.app.workspace.onLayoutReady(() => {
			this.observeLeaves();
			this.scheduleReorder();
		});

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if (!this.isReordering) {
					this.debouncedObserveLeaves();
				}
			}),
		);

		this.addCommand({
			id: "reorder-pinned-tabs",
			name: "Reorder pinned tabs",
			callback: () => this.scheduleReorder(),
		});
	}

	onunload() {
		if (this.observeDebounceTimer !== null) {
			window.clearTimeout(this.observeDebounceTimer);
			this.observeDebounceTimer = null;
		}
		this.reorderScheduled = false;
		this.isReordering = false;
	}

	/**
	 * Debounced version of observeLeaves — waits 200ms after the last
	 * layout-change before iterating all leaves. Prevents redundant
	 * iteration on rapid-fire events (tab switches, resizes, etc.).
	 */
	private debouncedObserveLeaves() {
		if (this.observeDebounceTimer !== null) {
			window.clearTimeout(this.observeDebounceTimer);
		}
		this.observeDebounceTimer = window.setTimeout(() => {
			this.observeDebounceTimer = null;
			this.observeLeaves();
		}, 200);
	}

	/**
	 * Registers `pinned-change` listeners on any new leaves that haven't
	 * been observed yet.
	 */
	private observeLeaves() {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (this.observedLeaves.has(leaf)) return;

			this.observedLeaves.add(leaf);
			this.registerEvent(
				leaf.on("pinned-change", () => {
					this.scheduleReorder();
				}),
			);
		});
	}

	/**
	 * Schedules a reorder pass on the next animation frame. Batches
	 * multiple triggers within the same frame into a single pass.
	 */
	private scheduleReorder() {
		if (this.reorderScheduled || this.isReordering) return;

		this.reorderScheduled = true;
		window.requestAnimationFrame(() => {
			this.reorderScheduled = false;
			this.reorderAllTabs();
		});
	}

	/**
	 * Walks the workspace tree and reorders tabs in each tab group so
	 * pinned tabs come first. Uses in-place manipulation to preserve
	 * all editor state.
	 */
	private reorderAllTabs() {
		if (this.isReordering) return;

		// Quick check: is any reorder actually needed?
		const tabGroups = this.collectTabGroups();
		const needsReorder = tabGroups.some((group) => this.tabGroupNeedsReorder(group));
		if (!needsReorder) return;

		this.isReordering = true;
		try {
			for (const tabGroup of tabGroups) {
				this.reorderTabGroup(tabGroup);
			}
		} finally {
			// Clear the flag on the next frame so layout-change events
			// triggered by our own DOM mutations are skipped.
			window.requestAnimationFrame(() => {
				this.isReordering = false;
			});
		}
	}

	/**
	 * Collects all tab groups from the workspace tree by recursively
	 * walking rootSplit.
	 */
	private collectTabGroups(): InternalTabGroup[] {
		const root = (this.app.workspace as unknown as { rootSplit: InternalSplitNode }).rootSplit;
		if (!root) return [];

		const groups: InternalTabGroup[] = [];
		this.walkNode(root, groups);
		return groups;
	}

	/**
	 * Recursively walks a workspace node tree collecting tab groups.
	 * A tab group is identified as a node that has `tabHeaderEls` and
	 * `children` where children are leaves (have `pinned` property).
	 */
	private walkNode(node: InternalSplitNode | InternalTabGroup, groups: InternalTabGroup[]) {
		if (this.isTabGroup(node)) {
			groups.push(node);
			return;
		}

		if (!Array.isArray(node.children)) return;

		for (const child of node.children) {
			this.walkNode(child, groups);
		}
	}

	/**
	 * Type guard: checks if a node is a tab group (has tabHeaderEls array
	 * and children that are leaves).
	 */
	private isTabGroup(node: unknown): node is InternalTabGroup {
		const n = node as InternalTabGroup;
		return (
			Array.isArray(n.children) &&
			Array.isArray(n.tabHeaderEls) &&
			n.children.length > 0 &&
			typeof (n.children[0] as InternalLeaf | undefined)?.pinned !== "undefined"
		);
	}

	/**
	 * Quick check: does this tab group have any pinned tab appearing after
	 * an unpinned tab? If not, no reorder is needed.
	 */
	private tabGroupNeedsReorder(tabGroup: InternalTabGroup): boolean {
		const children = tabGroup.children;
		if (children.length <= 1) return false;

		let seenUnpinned = false;
		for (const leaf of children) {
			if (!leaf.pinned) {
				seenUnpinned = true;
			} else if (seenUnpinned) {
				// Found a pinned tab after an unpinned one
				return true;
			}
		}
		return false;
	}

	/**
	 * Reorders a single tab group so pinned tabs come first while
	 * preserving relative order within each group (pinned-to-pinned,
	 * unpinned-to-unpinned).
	 *
	 * Syncs four things:
	 * 1. `children[]` — the leaf array (spliced in-place)
	 * 2. `tabHeaderEls[]` — Obsidian's tracked tab header references
	 * 3. `currentTab` — index of the active tab
	 * 4. DOM — tab headers inside `tabsInnerEl`, leaf containers
	 */
	private reorderTabGroup(tabGroup: InternalTabGroup) {
		const children = tabGroup.children;
		if (children.length <= 1) return;

		const pinned = children.filter((leaf) => leaf.pinned);
		const unpinned = children.filter((leaf) => !leaf.pinned);

		if (pinned.length === 0 || unpinned.length === 0) return;

		const sorted = [...pinned, ...unpinned];

		// Check if order actually changed
		const orderChanged = children.some((leaf, i) => leaf !== sorted[i]);
		if (!orderChanged) return;

		// Save reference to the currently active leaf before reorder
		const activeLeaf =
			typeof tabGroup.currentTab === "number" && tabGroup.currentTab < children.length
				? children[tabGroup.currentTab]
				: undefined;

		// 1. Splice children array in-place (preserves Obsidian references)
		children.length = 0;
		children.push(...sorted);

		// 2. Rebuild tabHeaderEls to match the new children order
		tabGroup.tabHeaderEls.length = 0;
		for (const leaf of sorted) {
			tabGroup.tabHeaderEls.push(leaf.tabHeaderEl);
		}

		// 3. Update currentTab to point to the same active leaf at its new index
		if (activeLeaf) {
			const newIndex = sorted.indexOf(activeLeaf);
			if (newIndex !== -1) {
				tabGroup.currentTab = newIndex;
			}
		}

		// 4. Reorder DOM: move tab headers inside tabsInnerEl
		if (tabGroup.tabsInnerEl) {
			for (const leaf of sorted) {
				tabGroup.tabsInnerEl.appendChild(leaf.tabHeaderEl);
			}
		}

		// 5. Reorder DOM: move leaf containers
		const tabContainer = tabGroup.containerEl?.querySelector(".workspace-tab-container");
		if (tabContainer) {
			for (const leaf of sorted) {
				tabContainer.appendChild(leaf.containerEl);
			}
		}

		// Let Obsidian refresh its internal display state
		if (typeof tabGroup.updateTabDisplay === "function") {
			tabGroup.updateTabDisplay();
		}
	}
}

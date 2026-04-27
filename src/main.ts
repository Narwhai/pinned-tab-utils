import { Plugin, WorkspaceLeaf, WorkspaceTabs } from "obsidian";

/**
 * Internal Obsidian types — not part of the public API but stable since 1.0.
 * Used for targeted, non-destructive tab reordering.
 */

interface InternalLeaf extends WorkspaceLeaf {
	pinned: boolean;
	tabHeaderEl: HTMLElement;
	containerEl: HTMLElement;
}

interface InternalTabGroup extends WorkspaceTabs {
	children: InternalLeaf[];
	tabHeaderEls: HTMLElement[];
	currentTab: number;
	tabsInnerEl: HTMLElement;
	containerEl: HTMLElement;
	updateTabDisplay(): void;
}

/**
 * Pinned Tab Utils — automatically moves pinned tabs to the left side of
 * the tab bar, mimicking browser behaviour.
 *
 * Uses targeted internal-API manipulation to reorder tabs in-place:
 * - Detects pin changes via the public `leaf.on("pinned-change")` event
 * - Uses public `leaf.parent` (WorkspaceTabs) to find the tab group directly
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
			this.scheduleFullReorder();
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
			callback: () => this.scheduleFullReorder(),
		});
	}

	onunload() {
		if (this.observeDebounceTimer !== null) {
			activeWindow.clearTimeout(this.observeDebounceTimer);
			this.observeDebounceTimer = null;
		}
		this.reorderScheduled = false;
		this.isReordering = false;
	}

	/**
	 * Debounced version of observeLeaves — waits 200ms after the last
	 * layout-change before iterating leaves. Prevents redundant iteration
	 * on rapid-fire events (tab switches, resizes, etc.).
	 */
	private debouncedObserveLeaves() {
		if (this.observeDebounceTimer !== null) {
			activeWindow.clearTimeout(this.observeDebounceTimer);
		}
		this.observeDebounceTimer = activeWindow.setTimeout(() => {
			this.observeDebounceTimer = null;
			this.observeLeaves();
			// New leaves from layout changes may need reordering
			this.scheduleFullReorder();
		}, 200);
	}

	/**
	 * Registers `pinned-change` listeners on any new leaves that haven't
	 * been observed yet. Uses the public `leaf.parent` property to find
	 * the containing tab group directly, avoiding tree traversal.
	 */
	private observeLeaves() {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (this.observedLeaves.has(leaf)) return;

			this.observedLeaves.add(leaf);
			this.registerEvent(
				leaf.on("pinned-change", () => {
					// Use leaf.parent to reorder only the affected tab group
					this.scheduleTargetedReorder(leaf);
				}),
			);
		});
	}

	/**
	 * Schedules a targeted reorder of just the tab group containing the
	 * given leaf. More efficient than a full reorder when we know exactly
	 * which tab was pinned/unpinned.
	 */
	private scheduleTargetedReorder(leaf: WorkspaceLeaf) {
		if (this.isReordering) return;

		activeWindow.requestAnimationFrame(() => {
			const tabGroup = this.getTabGroup(leaf);
			if (!tabGroup) return;
			this.reorderSingleTabGroup(tabGroup);
		});
	}

	/**
	 * Schedules a full reorder pass across all tab groups on the next
	 * animation frame. Batches multiple triggers within the same frame.
	 */
	private scheduleFullReorder() {
		if (this.reorderScheduled || this.isReordering) return;

		this.reorderScheduled = true;
		activeWindow.requestAnimationFrame(() => {
			this.reorderScheduled = false;
			this.reorderAllTabs();
		});
	}

	/**
	 * Gets the InternalTabGroup for a leaf using the public `leaf.parent`
	 * property. Returns null if the parent is not a WorkspaceTabs instance
	 * (e.g. on mobile it could be WorkspaceMobileDrawer).
	 */
	private getTabGroup(leaf: WorkspaceLeaf): InternalTabGroup | null {
		if (leaf.parent instanceof WorkspaceTabs) {
			return leaf.parent as InternalTabGroup;
		}
		return null;
	}

	/**
	 * Collects all unique tab groups by iterating all leaves and using
	 * their public `parent` property. Covers main area, popout windows,
	 * sidebars, and floating panes — anywhere a leaf can live.
	 */
	private collectTabGroups(): InternalTabGroup[] {
		const seen = new Set<WorkspaceTabs>();
		const groups: InternalTabGroup[] = [];

		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.parent instanceof WorkspaceTabs && !seen.has(leaf.parent)) {
				seen.add(leaf.parent);
				const group = leaf.parent as InternalTabGroup;
				// Verify this is a valid tab group with the expected internal properties
				if (Array.isArray(group.children) && Array.isArray(group.tabHeaderEls)) {
					groups.push(group);
				}
			}
		});

		return groups;
	}

	/**
	 * Reorders a single tab group with the re-entry guard.
	 */
	private reorderSingleTabGroup(tabGroup: InternalTabGroup) {
		if (this.isReordering) return;
		if (!this.tabGroupNeedsReorder(tabGroup)) return;

		this.isReordering = true;
		try {
			this.reorderTabGroup(tabGroup);
		} finally {
			activeWindow.requestAnimationFrame(() => {
				this.isReordering = false;
			});
		}
	}

	/**
	 * Walks all tab groups and reorders tabs so pinned tabs come first.
	 * Uses in-place manipulation to preserve all editor state.
	 */
	private reorderAllTabs() {
		if (this.isReordering) return;

		const tabGroups = this.collectTabGroups();
		const needsReorder = tabGroups.some((group) => this.tabGroupNeedsReorder(group));
		if (!needsReorder) return;

		this.isReordering = true;
		try {
			for (const tabGroup of tabGroups) {
				this.reorderTabGroup(tabGroup);
			}
		} finally {
			activeWindow.requestAnimationFrame(() => {
				this.isReordering = false;
			});
		}
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

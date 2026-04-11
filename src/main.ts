import { Plugin, WorkspaceLeaf } from "obsidian";

/**
 * Pinned Tab Utils — automatically moves pinned tabs to the left side of
 * the tab bar, mimicking browser behaviour.
 *
 * When a tab is pinned it slides to the rightmost position among existing
 * pinned tabs (i.e. just before the first unpinned tab).  When a tab is
 * unpinned it slides to the leftmost unpinned position (just after the last
 * pinned tab).  The relative order of pinned tabs among themselves — and of
 * unpinned tabs among themselves — is preserved.
 */
export default class PinnedTabUtilsPlugin extends Plugin {
	/** Guard to prevent re-entrant reordering triggered by our own DOM mutations. */
	private isReordering = false;

	/** Stores original methods so we can restore them on unload. */
	private origTogglePinned: typeof WorkspaceLeaf.prototype.togglePinned | null = null;
	private origSetPinned: typeof WorkspaceLeaf.prototype.setPinned | null = null;

	async onload() {
		this.app.workspace.onLayoutReady(() => {
			this.patchLeafMethods();
			this.reorderAllTabs();
		});

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if (!this.isReordering) {
					this.reorderAllTabs();
				}
			}),
		);

		// Manual reorder command as a safety-net / convenience.
		this.addCommand({
			id: "reorder-pinned-tabs",
			name: "Reorder pinned tabs",
			callback: () => this.reorderAllTabs(),
		});
	}

	onunload() {
		this.unpatchLeafMethods();
	}

	// ── Method patching ──────────────────────────────────────────────

	/**
	 * Monkey-patch WorkspaceLeaf.prototype.togglePinned and setPinned so
	 * that we can react to pin/unpin changes — there are no DOM changes or
	 * Obsidian events that signal a pin state change.
	 */
	private patchLeafMethods() {
		const self = this;

		this.origTogglePinned = WorkspaceLeaf.prototype.togglePinned;
		WorkspaceLeaf.prototype.togglePinned = function (...args: any[]) {
			const result = self.origTogglePinned!.apply(this, args);
			self.scheduleReorder(this);
			return result;
		};

		this.origSetPinned = WorkspaceLeaf.prototype.setPinned;
		WorkspaceLeaf.prototype.setPinned = function (pin: boolean, ...args: any[]) {
			const result = self.origSetPinned!.call(this, pin, ...args);
			self.scheduleReorder(this);
			return result;
		};
	}

	private unpatchLeafMethods() {
		if (this.origTogglePinned) {
			WorkspaceLeaf.prototype.togglePinned = this.origTogglePinned;
		}
		if (this.origSetPinned) {
			WorkspaceLeaf.prototype.setPinned = this.origSetPinned;
		}
	}

	// ── Reordering ────────────────────────────────────────────────────

	private scheduleReorder(triggerLeaf?: WorkspaceLeaf) {
		if (this.isReordering) return;

		this.isReordering = true;
		try {
			this.reorderAllTabs();
		} finally {
			// Reset the guard after the current event-loop tick so that
			// any layout-change event triggered by our reordering is
			// ignored.
			requestAnimationFrame(() => {
				this.isReordering = false;
			});
		}
	}

	/** Walk every tab group in the workspace and sort pinned tabs left. */
	private reorderAllTabs() {
		const rootSplit = (this.app.workspace as any).rootSplit;
		if (!rootSplit) return;
		this.walkWorkspace(rootSplit);
	}

	/** Recursively walk the workspace tree, sorting tab groups we encounter. */
	private walkWorkspace(item: any) {
		if (!item?.children) return;

		// A "tab group" is a parent whose children are all leaves
		// (no nested splits).
		const isTabGroup =
			item.children.length > 0 &&
			item.children.every((c: any) => !c.children);

		if (isTabGroup) {
			this.sortTabGroup(item);
		}

		// Recurse into children that are themselves parents (splits / tabs).
		for (const child of item.children) {
			if (child.children) {
				this.walkWorkspace(child);
			}
		}
	}

	/**
	 * Sort the leaves of a single tab group so all pinned leaves come first
	 * (maintaining their relative order) followed by all unpinned leaves
	 * (maintaining their relative order).
	 *
	 * Three things must be kept in sync:
	 * 1. `tabGroup.children` — internal leaf order
	 * 2. `tabGroup.tabHeaderEls` — Obsidian's array of tab-header DOM refs
	 * 3. The DOM — both tab headers inside `tabsInnerEl` and leaf content
	 *    containers
	 *
	 * If any of these get out of sync, `updateTabDisplay` will destroy
	 * our reorder or tabs will vanish from the tab bar.
	 */
	private sortTabGroup(tabGroup: any) {
		const leaves: any[] = tabGroup.children;
		if (!leaves || leaves.length <= 1) return;

		const pinned = leaves.filter((l: any) => l.pinned);
		const unpinned = leaves.filter((l: any) => !l.pinned);

		// Nothing to do if there are zero pinned or zero unpinned tabs —
		// the group is already homogeneous.
		if (pinned.length === 0 || unpinned.length === 0) return;

		const sorted = [...pinned, ...unpinned];

		// Quick check: skip if the order is already correct.
		let orderChanged = false;
		for (let i = 0; i < leaves.length; i++) {
			if (leaves[i] !== sorted[i]) {
				orderChanged = true;
				break;
			}
		}
		if (!orderChanged) return;

		// ── 1. Update internal state ────────────────────────────────

		// Remember which leaf is currently active before we reorder.
		const currentTabLeaf =
			tabGroup.children[tabGroup.currentTab ?? -1] ?? null;

		// Splice in-place so existing references (like activeLeaf) stay valid.
		tabGroup.children.splice(0, tabGroup.children.length, ...sorted);

		// Keep Obsidian's tabHeaderEls array in sync with the new order.
		if (tabGroup.tabHeaderEls) {
			tabGroup.tabHeaderEls = sorted
				.map((l: any) => l.tabHeaderEl)
				.filter(Boolean);
		}

		// Fix currentTab index — it must point to the same leaf after reorder.
		// If we don't update it, clicking a tab at the stale index will be a
		// no-op (Obsidian thinks it's already active) or activate the wrong tab.
		if (currentTabLeaf && tabGroup.currentTab !== undefined) {
			const newIndex = tabGroup.children.indexOf(currentTabLeaf);
			if (newIndex !== -1) {
				tabGroup.currentTab = newIndex;
			}
		}

		// ── 2. Reorder tab-header DOM elements ────────────────────────
		// Tab headers live inside `tabsInnerEl` (the
		// .workspace-tab-header-container-inner div), NOT directly inside
		// the outer .workspace-tab-header-container.  Appending to
		// tabsInnerEl preserves the correct flex layout.
		const tabsInnerEl = tabGroup.tabsInnerEl as HTMLElement | undefined;
		if (tabsInnerEl) {
			for (const leaf of sorted) {
				if (leaf.tabHeaderEl) {
					tabsInnerEl.appendChild(leaf.tabHeaderEl);
				}
			}
		}

		// ── 3. Reorder leaf-container DOM elements ──────────────────
		const tabContainer = tabGroup.containerEl?.querySelector(
			":scope > .workspace-tab-container",
		) as HTMLElement | null;
		if (tabContainer) {
			for (const leaf of sorted) {
				if (leaf.containerEl) {
					tabContainer.appendChild(leaf.containerEl);
				}
			}
		}
	}
}
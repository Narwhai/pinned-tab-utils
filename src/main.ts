import { Plugin, WorkspaceLeaf } from "obsidian";

interface WorkspaceLayoutLeaf {
	id?: string;
	type: "leaf";
	pinned?: boolean;
	state?: {
		pinned?: boolean;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

interface WorkspaceLayoutNode {
	id?: string;
	type: string;
	children?: WorkspaceLayoutChild[];
	currentTab?: number;
	[key: string]: unknown;
}

type WorkspaceLayoutChild = WorkspaceLayoutLeaf | WorkspaceLayoutNode;

interface WorkspaceLayoutSnapshot {
	main?: WorkspaceLayoutNode;
	left?: WorkspaceLayoutNode;
	right?: WorkspaceLayoutNode;
	floating?: WorkspaceLayoutNode[];
	active?: string;
	[key: string]: unknown;
}

/**
 * Pinned Tab Utils — automatically moves pinned tabs to the left side of
 * the tab bar, mimicking browser behaviour.
 *
 * Uses the public Obsidian API to:
 * - detect pin changes via `leaf.on("pinned-change")`
 * - enumerate leaves via `workspace.iterateAllLeaves()`
 * - reorder tabs by rewriting the serialized workspace layout with
 *   `workspace.getLayout()` + `workspace.changeLayout()`
 */
export default class PinnedTabUtilsPlugin extends Plugin {
	private observedLeaves = new WeakSet<WorkspaceLeaf>();
	private reorderScheduled = false;
	private isApplyingLayout = false;

	async onload() {
		this.app.workspace.onLayoutReady(() => {
			this.observeLeaves();
			this.scheduleReorder();
		});

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.observeLeaves();
				if (!this.isApplyingLayout) {
					this.scheduleReorder();
				}
			}),
		);

		this.addCommand({
			id: "reorder-pinned-tabs",
			name: "Reorder pinned tabs",
			callback: () => this.scheduleReorder(),
		});
	}

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

	private scheduleReorder() {
		if (this.reorderScheduled || this.isApplyingLayout) return;

		this.reorderScheduled = true;
		window.requestAnimationFrame(() => {
			this.reorderScheduled = false;
			void this.reorderAllTabs();
		});
	}

	private async reorderAllTabs() {
		if (this.isApplyingLayout) return;

		const layout = this.cloneLayout(this.app.workspace.getLayout());
		const changed = this.reorderLayoutSnapshot(layout);
		if (!changed) return;

		this.isApplyingLayout = true;
		try {
			await this.app.workspace.changeLayout(layout);
		} finally {
			window.requestAnimationFrame(() => {
				this.isApplyingLayout = false;
				this.observeLeaves();
			});
		}
	}

	private cloneLayout(layout: Record<string, unknown>): WorkspaceLayoutSnapshot {
		return JSON.parse(JSON.stringify(layout)) as WorkspaceLayoutSnapshot;
	}

	private reorderLayoutSnapshot(layout: WorkspaceLayoutSnapshot): boolean {
		let changed = false;

		if (layout.main) {
			changed = this.reorderLayoutNode(layout.main) || changed;
		}
		if (layout.left) {
			changed = this.reorderLayoutNode(layout.left) || changed;
		}
		if (layout.right) {
			changed = this.reorderLayoutNode(layout.right) || changed;
		}
		if (Array.isArray(layout.floating)) {
			for (const node of layout.floating) {
				changed = this.reorderLayoutNode(node) || changed;
			}
		}

		return changed;
	}

	private reorderLayoutNode(node: WorkspaceLayoutNode): boolean {
		let changed = false;

		if (node.type === "tabs" && Array.isArray(node.children)) {
			changed = this.reorderTabGroup(node) || changed;
		}

		if (!Array.isArray(node.children)) return changed;

		for (const child of node.children) {
			if (this.isLayoutNode(child)) {
				changed = this.reorderLayoutNode(child) || changed;
			}
		}

		return changed;
	}

	private reorderTabGroup(tabGroup: WorkspaceLayoutNode): boolean {
		const children = tabGroup.children;
		if (!children || children.length <= 1) return false;
		if (!children.every((child) => this.isLeafLayout(child))) return false;

		const leaves = children;
		const pinned = leaves.filter((leaf) => this.isPinnedLeaf(leaf));
		const unpinned = leaves.filter((leaf) => !this.isPinnedLeaf(leaf));

		if (pinned.length === 0 || unpinned.length === 0) return false;

		const sorted = [...pinned, ...unpinned];
		const orderChanged = leaves.some((leaf, index) => leaf !== sorted[index]);
		if (!orderChanged) return false;

		const currentTabLeaf =
			typeof tabGroup.currentTab === "number" ? leaves[tabGroup.currentTab] : undefined;

		tabGroup.children = sorted;

		if (currentTabLeaf) {
			const newIndex = sorted.indexOf(currentTabLeaf);
			if (newIndex !== -1) {
				tabGroup.currentTab = newIndex;
			}
		}

		return true;
	}

	private isLayoutNode(child: WorkspaceLayoutChild): child is WorkspaceLayoutNode {
		return child.type !== "leaf";
	}

	private isLeafLayout(child: WorkspaceLayoutChild): child is WorkspaceLayoutLeaf {
		return child.type === "leaf";
	}

	private isPinnedLeaf(leaf: WorkspaceLayoutLeaf): boolean {
		return leaf.pinned === true || leaf.state?.pinned === true;
	}
}

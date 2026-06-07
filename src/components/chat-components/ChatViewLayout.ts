import { Platform, Workspace } from "obsidian";

/** Wait for CSS transitions to settle before re-measuring after a theme switch. */
const CSS_CHANGE_DEBOUNCE_MS = 600;

/**
 * Manages layout concerns for the Copilot chat view, such as status bar
 * clearance and (in the future) chat input collapse state.
 *
 * Instantiated once per CopilotView and tied to its lifecycle.
 */
export class ChatViewLayout {
  private debounceTimer: number | null = null;
  private cssChangeRef: ReturnType<Workspace["on"]> | null = null;
  private statusBarResizeObserver: ResizeObserver | null = null;
  private observedStatusBar: HTMLElement | null = null;

  constructor(
    private containerEl: HTMLElement,
    private workspace: Workspace
  ) {
    this.setupStatusBarClearance();
  }

  /**
   * Tear down observers and timers. Call from CopilotView.onClose().
   */
  destroy(): void {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.cssChangeRef) {
      this.workspace.offref(this.cssChangeRef);
      this.cssChangeRef = null;
    }
    this.statusBarResizeObserver?.disconnect();
    this.statusBarResizeObserver = null;
    this.observedStatusBar = null;
  }

  /**
   * Measure how much the status bar overlaps the view-content and expose
   * the overlap as a CSS variable so padding adapts to any theme.
   *
   * Works by temporarily zeroing the clearance, measuring the geometric
   * overlap, then setting the correct value -- all within one synchronous
   * reflow so nothing flickers. Themes that already position content above
   * the status bar (no overlap) get 0 clearance automatically. Auto-hide
   * themes (opacity: 0) also get 0 since the bar is transparent.
   *
   * The desktop status bar lives in the bottom-right and hosts core and
   * plugin items (update-available notice, sync status, word count, ...).
   * When one of those appears or grows -- making the bar taller, e.g. items
   * wrap to a second line -- the overlap changes without a `css-change`
   * event, so a ResizeObserver on the bar keeps the clearance in sync and
   * the chat input from being covered. Measuring the bar's geometry stays
   * generalizable: no specific banner or plugin is hardcoded.
   */
  private setupStatusBarClearance(): void {
    if (Platform.isMobile) return;

    const syncClearance = () => {
      // Re-query each time to avoid stale references after theme reloads.
      const statusBar = this.containerEl.doc.querySelector<HTMLElement>(".status-bar");
      const viewContent = this.containerEl.querySelector<HTMLElement>(".view-content");
      if (!statusBar || !viewContent) return;

      this.observeStatusBar(statusBar, syncClearance);

      // Zero out clearance and force reflow to measure natural overlap.
      // Remove any inline override left from a prior run so the CSS default
      // (0px) applies and the resulting rect reflects the natural overlap.
      viewContent.setCssProps({ "--copilot-status-bar-clearance": "" });
      const overlap =
        viewContent.getBoundingClientRect().bottom - statusBar.getBoundingClientRect().top;

      if (overlap <= 0) {
        // Theme layout already clears the status bar.
        return;
      }

      // Overlap exists -- only add clearance if the bar is actually visible.
      const s = getComputedStyle(statusBar);
      const hidden =
        s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0;
      viewContent.setCssProps({
        "--copilot-status-bar-clearance": `${hidden ? 0 : Math.ceil(overlap)}px`,
      });
    };

    syncClearance();

    this.cssChangeRef = this.workspace.on("css-change", () => {
      if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
      this.debounceTimer = window.setTimeout(syncClearance, CSS_CHANGE_DEBOUNCE_MS);
    });
  }

  /**
   * Keep a single ResizeObserver pointed at the current status bar element so
   * runtime size changes re-trigger a measurement. Rebinds when the element is
   * replaced (e.g. after a theme reload swaps the DOM); a no-op otherwise.
   */
  private observeStatusBar(statusBar: HTMLElement, onResize: () => void): void {
    if (this.observedStatusBar === statusBar) return;
    this.statusBarResizeObserver?.disconnect();
    this.statusBarResizeObserver = new ResizeObserver(() => onResize());
    this.statusBarResizeObserver.observe(statusBar);
    this.observedStatusBar = statusBar;
  }
}

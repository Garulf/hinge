import { isPackageName } from "../shared/package-name";
import { globalTimers, type Timers } from "../shared/popout";
import { afterPopoutClosed, onMainWindowClose } from "./lifecycle";
import type { PopoutManager } from "./popout-manager";

/** How long an --app launch may wait for its pop-out before the main window shows the phone's status instead. */
export const SHOW_MAIN_WITHOUT_POPOUT_MS = 5000;

export interface AppShellDeps {
  showWindow(): void;
  hideWindow(): void;
  setMainVideo(on: boolean): void;
  companionWanted(on: boolean): void;
  popouts: Pick<PopoutManager, "count" | "open" | "onCountChanged">;
  /** Whether closing the main window leaves hinge running in the tray: the setting is on and there is a tray to come back from. */
  toTray(): boolean;
  quit(): void;
  /** Shown in the main window, or as a system notification while it is hidden. */
  notice(text: string): void;
  log(line: string): void;
  timers?: Timers;
}

/**
 * Whether the main window is shown, tracked here rather than read back from
 * the window: every show and hide goes through this, so the main video, the
 * companion and the quit rules always agree with it.
 */
export class AppShell {
  readonly #deps: AppShellDeps;
  readonly #startHidden: boolean;
  readonly #timers: Timers;
  #hidden: boolean;
  #fallback: ReturnType<Timers["set"]> | null = null;

  constructor(deps: AppShellDeps, o: { startHidden: boolean }) {
    this.#deps = deps;
    this.#startHidden = o.startHidden;
    this.#hidden = o.startHidden;
    this.#timers = deps.timers ?? globalTimers;
  }

  get mainVisible(): boolean {
    return !this.#hidden;
  }

  start(): void {
    this.#deps.popouts.onCountChanged((n) => this.#popoutsChanged(n));
    this.#refreshCompanion();
    if (!this.#startHidden) return;
    this.#fallback = this.#timers.set(() => {
      this.#fallback = null;
      if (this.#hidden) this.showMain();
    }, SHOW_MAIN_WITHOUT_POPOUT_MS);
  }

  showMain(): void {
    this.#hidden = false;
    this.#deps.showWindow();
    this.#deps.setMainVideo(true);
    this.#refreshCompanion();
  }

  /** The window system's close: hides the main window while pop-outs are open or hinge closes to the tray, otherwise lets the close quit hinge. */
  closeRequested(): "hide" | "quit" {
    const outcome = onMainWindowClose({ popouts: this.#deps.popouts.count(), toTray: this.#deps.toTray() });
    if (outcome === "hide") this.#hideMain();
    return outcome;
  }

  /** The menu's close button: hides the main window to the tray when hinge closes there, otherwise quits, pop-outs and all. */
  closeButton(): void {
    if (this.#deps.toTray()) this.#hideMain();
    else this.#deps.quit();
  }

  /** hinge is quitting: the --app launch's wait must not bring the main window up during a slow quit. */
  quitting(): void {
    this.#cancelFallback();
  }

  /** A second launch of hinge, with the app it asked for. */
  launch(app: string | null): void {
    if (app === null) {
      this.showMain();
      return;
    }
    if (!isPackageName(app)) {
      this.#deps.log(`not opening ${JSON.stringify(app)}: not an app package`);
      this.showMain();
      this.#deps.notice(`Not an app package: ${app}`);
      return;
    }
    if (this.#deps.popouts.open(app) === "queued") this.#deps.notice(`Waiting for the phone to open ${app}`);
  }

  #hideMain(): void {
    this.#hidden = true;
    this.#deps.hideWindow();
    this.#deps.setMainVideo(false);
    this.#refreshCompanion();
  }

  #popoutsChanged(n: number): void {
    if (n > 0) this.#cancelFallback();
    this.#refreshCompanion();
    if (afterPopoutClosed({ mainVisible: this.mainVisible, popouts: n, toTray: this.#deps.toTray() }) === "quit") this.#deps.quit();
  }

  #cancelFallback(): void {
    if (this.#fallback !== null) this.#timers.clear(this.#fallback);
    this.#fallback = null;
  }

  #refreshCompanion(): void {
    this.#deps.companionWanted(this.mainVisible || this.#deps.popouts.count() > 0);
  }
}

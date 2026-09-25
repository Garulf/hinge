export type ViewMode = "work" | "showcase";

export interface ViewMemoryDeps {
  /** Shows the view: eased when the user toggles it, at once (`instant`) when it is restored for a phone or at startup. */
  apply(view: ViewMode, opts: { instant: boolean }): void;
  /** Remembers a view the user chose, for the phone on screen (null before any phone) and as the default for new ones. */
  save(serial: string | null, view: ViewMode): void;
}

/** MOD+d's work or showcase view, remembered per phone. */
export class ViewMemory {
  readonly #deps: ViewMemoryDeps;
  #view: ViewMode;
  #serial: string | null = null;

  constructor(deps: ViewMemoryDeps, initial: ViewMode) {
    this.#deps = deps;
    this.#view = initial;
    deps.apply(initial, { instant: true });
  }

  get view(): ViewMode {
    return this.#view;
  }

  toggle(): ViewMode {
    this.#show(this.#view === "work" ? "showcase" : "work", false);
    this.#deps.save(this.#serial, this.#view);
    return this.#view;
  }

  /** A phone started streaming: a different phone gets its own saved view, or the last one chosen; the same phone keeps what is on screen. */
  useDevice(serial: string, saved: ViewMode | undefined): void {
    if (this.#serial === serial) return;
    this.#serial = serial;
    if (saved) this.#show(saved, true);
  }

  #show(view: ViewMode, instant: boolean): void {
    if (view === this.#view) return;
    this.#view = view;
    this.#deps.apply(view, { instant });
  }
}

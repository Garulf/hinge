/** hinge keeps running, its main window hidden, while any pop-out is open. */
export function onMainWindowClose(o: { popouts: number }): "hide" | "quit" {
  return o.popouts > 0 ? "hide" : "quit";
}

export function afterPopoutClosed(o: { mainVisible: boolean; popouts: number }): "quit" | "stay" {
  return !o.mainVisible && o.popouts === 0 ? "quit" : "stay";
}

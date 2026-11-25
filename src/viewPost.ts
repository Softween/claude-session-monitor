/**
 * viewPost.ts - what the Sessions and Usage limits webview views are sent. A
 * payload goes out only while its view is visible, and only when its JSON
 * differs from the last one of its type ("update", the Burn tab's "burn") that
 * the view's page received. The views run without retainContextWhenHidden, so
 * a hidden view loses its page: when it shows again, the latest payload of each
 * type is posted at once. No vscode import.
 */

/** The part of a vscode.WebviewView this needs. */
export interface PostView {
  readonly visible: boolean;
  onDidChangeVisibility(listener: () => void): unknown;
  readonly webview: { postMessage(message: unknown): unknown }; // vscode: Thenable<boolean>
}

export class ViewPoster {
  private view?: PostView;
  private readonly latest = new Map<string, unknown>(); // payload type -> the newest payload
  private readonly delivered = new Map<string, string>(); // payload type -> the JSON the view's page last received

  /** A resolved view comes with a new page: it gets the latest payload of each type, now or when it shows. */
  attach(view: PostView): void {
    this.view = view;
    this.delivered.clear();
    view.onDidChangeVisibility(() => {
      if (this.view !== view) return; // a later resolve replaced this view
      this.delivered.clear(); // hidden: its page is gone; shown: a new page waits for its first payloads
      if (view.visible) this.flush();
    });
    this.flush();
  }

  /** The newest payload of its type; posted when the view shows and its page has not received this JSON yet. */
  post(payload: { readonly type: string }): void {
    this.latest.set(payload.type, payload);
    this.send(payload.type);
  }

  private flush(): void {
    for (const type of this.latest.keys()) this.send(type);
  }

  private send(type: string): void {
    const view = this.view;
    if (!view?.visible) return;
    const payload = this.latest.get(type);
    const json = JSON.stringify(payload);
    if (this.delivered.get(type) === json) return;
    const sent = view.webview.postMessage(payload); // a throw leaves `delivered` as it was: the next post tries again
    this.delivered.set(type, json);
    const forget = (): void => {
      if (this.delivered.get(type) === json) this.delivered.delete(type);
    };
    // false: the page did not take it (the view was hidden or disposed meanwhile); the next post sends it again.
    void Promise.resolve(sent).then((ok) => {
      if (ok === false) forget();
    }, forget);
  }
}

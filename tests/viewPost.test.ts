import { describe, expect, it } from "vitest";
import { ViewPoster } from "../src/viewPost";

/** A webview view as VS Code resolves it: what its page was sent, and its visibility. */
function fakeView(visible = true) {
  const posted: unknown[] = [];
  const listeners: Array<() => void> = [];
  const state = { delivers: true, throws: false };
  const view = {
    visible,
    onDidChangeVisibility: (listener: () => void) => {
      listeners.push(listener);
      return { dispose() {} };
    },
    webview: {
      postMessage: (message: unknown): Promise<boolean> => {
        if (state.throws) throw new Error("view gone");
        posted.push(message);
        return Promise.resolve(state.delivers);
      },
    },
  };
  const setVisible = (value: boolean): void => {
    view.visible = value;
    for (const listener of listeners) listener();
  };
  return { view, posted, state, setVisible };
}

const update = (n: number) => ({ type: "update", n });
const burn = (n: number) => ({ type: "burn", n });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("webview view posts", () => {
  it("posts a payload only when its JSON differs from the last one the page got", () => {
    const poster = new ViewPoster();
    const v = fakeView();
    poster.attach(v.view);
    poster.post(update(1));
    poster.post(update(1)); // a new object with the same JSON
    poster.post(update(2));
    poster.post(update(2));
    expect(v.posted).toEqual([update(1), update(2)]);
  });

  it("keeps each payload type apart", () => {
    const poster = new ViewPoster();
    const v = fakeView();
    poster.attach(v.view);
    poster.post(update(1));
    poster.post(burn(1));
    poster.post(update(1));
    poster.post(burn(1));
    poster.post(burn(2));
    expect(v.posted).toEqual([update(1), burn(1), burn(2)]);
  });

  it("posts nothing while the view is hidden, and the latest of each type when it shows", () => {
    const poster = new ViewPoster();
    const v = fakeView();
    poster.attach(v.view);
    poster.post(update(1));
    v.setVisible(false);
    poster.post(update(2));
    poster.post(burn(1));
    poster.post(update(3));
    expect(v.posted).toEqual([update(1)]);
    v.setVisible(true);
    expect(v.posted).toEqual([update(1), update(3), burn(1)]);
    poster.post(update(3));
    expect(v.posted).toHaveLength(3);
  });

  it("a view shown again gets the latest payload again, changed or not: its page was rebuilt", () => {
    const poster = new ViewPoster();
    const v = fakeView();
    poster.attach(v.view);
    poster.post(update(1));
    v.setVisible(false);
    v.setVisible(true);
    expect(v.posted).toEqual([update(1), update(1)]);
  });

  it("payloads posted before the view resolves are sent when it resolves, and again to a view resolved anew", () => {
    const poster = new ViewPoster();
    poster.post(update(1));
    poster.post(burn(1));
    const first = fakeView();
    poster.attach(first.view);
    expect(first.posted).toEqual([update(1), burn(1)]);
    const second = fakeView();
    poster.attach(second.view);
    expect(second.posted).toEqual([update(1), burn(1)]);
    first.setVisible(false);
    first.setVisible(true); // the replaced view's events post nothing
    poster.post(update(2));
    expect(first.posted).toHaveLength(2);
    expect(second.posted).toEqual([update(1), burn(1), update(2)]);
  });

  it("a view that resolves hidden gets its payloads when it shows", () => {
    const poster = new ViewPoster();
    poster.post(update(1));
    const v = fakeView(false);
    poster.attach(v.view);
    expect(v.posted).toEqual([]);
    v.setVisible(true);
    expect(v.posted).toEqual([update(1)]);
  });

  it("a post that throws is tried again by the next post of the same payload", () => {
    const poster = new ViewPoster();
    const v = fakeView();
    poster.attach(v.view);
    v.state.throws = true;
    expect(() => poster.post(update(1))).toThrow("view gone");
    v.state.throws = false;
    poster.post(update(1));
    expect(v.posted).toEqual([update(1)]);
  });

  it("a post the webview did not take is sent again by the next post of the same payload", async () => {
    const poster = new ViewPoster();
    const v = fakeView();
    poster.attach(v.view);
    v.state.delivers = false;
    poster.post(update(1));
    await settle();
    v.state.delivers = true;
    poster.post(update(1));
    await settle();
    poster.post(update(1));
    expect(v.posted).toEqual([update(1), update(1)]);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { anchorRect, showCopiedSticker } from "./copy-sticker.js";

/**
 * A DOM stub small enough to assert against directly. `showCopiedSticker` only
 * touches `createElement`, `body.appendChild`, `querySelectorAll` and the
 * anchor's rect, so faking those is enough to pin the placement rules.
 */
function stubDom(innerWidth = 1000) {
  const body = { children: [], appendChild(node) { this.children.push(node); } };
  const created = [];
  global.window = { innerWidth };
  global.document = {
    createElement() {
      const node = {
        className: "", textContent: "", style: {}, listeners: {},
        addEventListener(event, fn) { this.listeners[event] = fn; },
        remove() { body.children = body.children.filter((child) => child !== node); },
      };
      created.push(node);
      return node;
    },
    body,
    querySelectorAll() { return body.children.filter((child) => child.className === "copied-sticker"); },
  };
  return { body, created };
}

const anchorAt = (left, right) => ({ left, right, top: 200, width: right - left, height: 40 });

test("pins the sticker beside the control that was clicked", () => {
  const { body } = stubDom();
  showCopiedSticker(anchorAt(300, 400));

  assert.equal(body.children.length, 1);
  const [sticker] = body.children;
  assert.equal(sticker.className, "copied-sticker");
  assert.equal(sticker.textContent, "COPIED");
  assert.equal(sticker.style.left, "410px");
  // Vertically centred on the control: top + height / 2.
  assert.equal(sticker.style.top, "220px");
});

test("flips to the left of the control when the viewport has no room on the right", () => {
  const { body } = stubDom(1000);
  showCopiedSticker(anchorAt(880, 960));

  const [sticker] = body.children;
  assert.equal(sticker.style.left, undefined);
  assert.equal(sticker.style.right, "130px");
});

test("replaces an in-flight sticker rather than stacking on rapid clicks", () => {
  const { body } = stubDom();
  showCopiedSticker(anchorAt(300, 400));
  showCopiedSticker(anchorAt(300, 400));
  showCopiedSticker(anchorAt(300, 400));

  assert.equal(body.children.length, 1);
});

test("removes itself once the animation ends, leaving no orphan node", () => {
  const { body } = stubDom();
  showCopiedSticker(anchorAt(300, 400));

  body.children[0].listeners.animationend();
  assert.equal(body.children.length, 0);
});

test("is a no-op without an anchor, so a copy never throws on feedback", () => {
  const { body } = stubDom();
  assert.doesNotThrow(() => showCopiedSticker(undefined));
  assert.doesNotThrow(() => showCopiedSticker(null));
  assert.equal(body.children.length, 0);
});

/**
 * The regression this module was rewritten for. `guard` re-renders `#app` before
 * running the work, so the clicked button is detached by the time the copy
 * resolves; a detached node measures as all zeros and parked every sticker in
 * the top-left corner of the page.
 */
test("refuses to place a sticker from the all-zero rect of a detached node", () => {
  const { body } = stubDom();
  showCopiedSticker({ left: 0, right: 0, top: 0, width: 0, height: 0 });
  assert.equal(body.children.length, 0, "a zero rect is a detached node, not the top-left corner");
});

test("anchorRect snapshots the position instead of holding the element", () => {
  const live = { getBoundingClientRect: () => ({ left: 10, right: 90, top: 50, width: 80, height: 40 }) };
  const snapshot = anchorRect(live);

  assert.deepEqual(snapshot, { left: 10, right: 90, top: 50, width: 80, height: 40 });
  // A plain snapshot survives the element being torn out of the DOM.
  assert.equal(typeof snapshot.getBoundingClientRect, "undefined");
  assert.equal(anchorRect(null), null);
  assert.equal(anchorRect({}), null);
});

test("copying reports through the sticker, not the notice card", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./main.js", import.meta.url), "utf8");
  const copyValueSource = source.slice(source.indexOf("async function copyValue("), source.indexOf("async function confirmIdentitySetup("));

  assert.match(copyValueSource, /showCopiedSticker\(rect\)/);
  assert.doesNotMatch(copyValueSource, /state\.notice/);
  // Both bindings must measure SYNCHRONOUSLY at click time and forward the rect.
  // Passing `button` here is the bug: `guard` re-renders before the copy resolves.
  assert.match(source, /const rect = anchorRect\(button\);\s*void guard\(\(\) => copyValue\(button\.dataset\.copyLabel, button\.dataset\.copyShielded, rect\), null, "copy"\)/);
  assert.match(source, /const rect = anchorRect\(button\);\s*void guard\(\(\) => copyValue\(button\.dataset\.copyLabel, button\.dataset\.copy, rect\), null, "copy"\)/);
  assert.doesNotMatch(source, /copyValue\([^)]*, button\)/);
});

test("copying the recovery phrase uses the same anchored sticker", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./main.js", import.meta.url), "utf8");
  const copyPhraseSource = source.slice(source.indexOf("async function copySetupMnemonic("), source.indexOf("async function copyValue("));

  assert.match(copyPhraseSource, /showCopiedSticker\(rect\)/);
  assert.doesNotMatch(copyPhraseSource, /state\.notice/);
  assert.match(source, /on\("#copy-phrase", "click", \(event\) => \{\s*\/\/ `guard` re-renders[\s\S]*?const rect = anchorRect\(event\.currentTarget\);\s*void guard\(\(\) => copySetupMnemonic\(rect\), null, "copy-phrase"\);/);
});

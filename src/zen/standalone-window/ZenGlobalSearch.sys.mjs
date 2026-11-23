// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";

export const shortcutPref = "zen.standalone-window.global-search-shortcut";
const enabledPref = "zen.standalone-window.enabled";
const defaultShortcut = "meta,alt|KeyT";
const modifierNames = ["control", "meta", "alt", "shift"];
const modifierSymbols = ["⌃", "⌘", "⌥", "⇧"];

function parseShortcut(value) {
  const parts = value.split("|");
  if (parts.length !== 2 || !/^(Key[A-Z]|Digit\d|F(?:[1-9]|1\d|20))$/.test(parts[1])) {
    return null;
  }
  let flags = 0;
  for (const name of parts[0].split(",")) {
    const index = modifierNames.indexOf(name);
    if (index < 0 || flags & (1 << index)) {
      return null;
    }
    flags |= 1 << index;
  }
  return flags & 7 ? { code: parts[1], flags } : null;
}

function conflictsWithBrowserShortcut({ code, flags }) {
  const key = code.replace(/^(Key|Digit)/, "");
  // These standard application commands may have no key element at startup.
  if (flags === 2 && ["Q", "W", "C", "X", "V", "A", "Z", "H", "M"].includes(key)) {
    return true;
  }
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    for (const node of win.document.querySelectorAll("key[modifiers]")) {
      const binding = node.getAttribute("key") || node.getAttribute("keycode")?.replace(/^VK_/, "");
      if (binding?.toUpperCase() !== key || node.getAttribute("disabled") === "true") {
        continue;
      }
      const names = node.getAttribute("modifiers").replace(/\baccel\b/g, "meta").split(/[\s,]+/);
      const mask = modifierNames.reduce((bits, name, i) => names.includes(name) ? bits | (1 << i) : bits, 0);
      if (mask === flags) {
        return true;
      }
    }
  }
  return false;
}

export function recordShortcut(event) {
  const pressed = [event.ctrlKey, event.metaKey, event.altKey, event.shiftKey];
  const names = modifierNames.filter((_, index) => pressed[index]);
  const value = names.join(",") + "|" + event.code;
  return parseShortcut(value) ? value : null;
}

export function formatShortcut(value) {
  const shortcut = parseShortcut(value);
  if (!shortcut) {
    return "";
  }
  return modifierSymbols.filter((_, i) => shortcut.flags & (1 << i)).join("") +
    shortcut.code.replace(/^(Key|Digit)/, "");
}

export const gZenGlobalSearch = {
  panel: null,
  registered: null,
  available: true,
  theme: {},

  rememberTheme(win) {
    const root = win?.document?.documentElement;
    if (root?.getAttribute("windowtype") !== "navigator:browser" ||
        win._zenStandaloneWindow || PrivateBrowsingUtils.isWindowPrivate(win)) {
      return;
    }
    this.theme = {
      accent: root.style.getPropertyValue("--zen-primary-color"),
      scheme: root.style.getPropertyValue("--toolbar-color-scheme"),
    };
  },

  get enabled() {
    return Services.prefs.getBoolPref(enabledPref, false) &&
      !PrivateBrowsingUtils.permanentPrivateBrowsing;
  },

  init() {
    if (AppConstants.platform !== "macosx" || Cu.isInAutomation) {
      return;
    }
    Services.obs.addObserver(this, "browser-delayed-startup-finished");
    Services.obs.addObserver(this, "domwindowclosed");
    Services.obs.addObserver(this, "zen-global-search");
    Services.obs.addObserver(this, "zen-global-search-dismiss");
    Services.obs.addObserver(this, "quit-application-granted");
    Services.prefs.addObserver(shortcutPref, this);
    Services.prefs.addObserver(enabledPref, this);
    this.syncShortcut();
  },

  observe(subject, topic) {
    if (topic === "domwindowclosed") {
      this.rememberTheme(subject);
    } else if (topic === "nsPref:changed" || topic === "browser-delayed-startup-finished") {
      this.syncShortcut();
    } else if (topic === "quit-application-granted") {
      Services.prefs.removeObserver(shortcutPref, this);
      Services.prefs.removeObserver(enabledPref, this);
      Services.obs.removeObserver(this, "browser-delayed-startup-finished");
      Services.obs.removeObserver(this, "domwindowclosed");
      Services.obs.removeObserver(this, "zen-global-search");
      Services.obs.removeObserver(this, "zen-global-search-dismiss");
      Services.obs.removeObserver(this, topic);
      Services.zen.clearSearchHotkey();
      this.close();
    } else if (topic === "zen-global-search-dismiss" || (this.panel && !this.panel.closed)) {
      this.close();
    } else if (this.enabled) {
      this.rememberTheme(Services.wm.getMostRecentWindow("navigator:browser"));
      Services.zen.prepareSearchPanel();
      try {
        this.panel = Services.ww.openWindow(null,
          "chrome://browser/content/zen-global-search.xhtml", "_blank",
          "chrome,dialog=no,titlebar=no,resizable=no,width=680,height=480", null);
      } finally {
        Services.zen.cancelPreparedStandalonePanel();
      }
    }
  },

  syncShortcut() {
    const value = Services.prefs.getStringPref(shortcutPref, defaultShortcut);
    if (!this.enabled) {
      Services.zen.clearSearchHotkey();
      this.registered = null;
      this.available = true;
      this.close();
    } else {
      const shortcut = parseShortcut(value);
      const allowed = shortcut && !conflictsWithBrowserShortcut(shortcut);
      if (!allowed && this.registered === value) {
        Services.zen.clearSearchHotkey();
        this.registered = null;
      }
      this.available = !!allowed && (value === this.registered ||
        Services.zen.setSearchHotkey(shortcut.code, shortcut.flags));
      if (this.available) {
        this.registered = value;
      } else if (this.registered) {
        Services.prefs.setStringPref(shortcutPref, this.registered);
        this.available = false;
      }
    }
    Services.obs.notifyObservers(null, "zen-global-search-shortcut-changed");
  },

  close(win = this.panel) {
    if (!win || win !== this.panel) {
      return;
    }
    this.panel = null;
    if (!win.closed) {
      try {
        win.gURLBar?.view?.close();
      } finally {
        win.close();
      }
    }
  },
};

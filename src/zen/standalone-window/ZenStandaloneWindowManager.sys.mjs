/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-disable mozilla/valid-services -- Services.zen is Zen's custom XPCOM service. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "MacDockSupport", () => {
  if (AppConstants.platform !== "macosx") {
    return null;
  }
  try {
    const service = Cc["@mozilla.org/widget/macdocksupport;1"].getService(
      Ci.nsIMacDockSupport
    );
    return {
      get millisecondsSinceApplicationActivated() {
        return service.millisecondsSinceApplicationActivated;
      },
      get isApplicationActive() {
        return service.isApplicationActive;
      },
      activatePreviousApplication() {
        service.hideApplication();
      },
      makeWindowJoinActiveSpace(baseWindow) {
        service.makeWindowJoinActiveSpace(baseWindow);
      },
      activateApplication(ignoreOtherApplications = false) {
        service.activateApplication(ignoreOtherApplications);
      },
    };
  } catch (error) {
    console.error(
      "Zen standalone windows cannot reach macOS dock support",
      error
    );
    return null;
  }
});

export const ZEN_STANDALONE_WINDOW_TYPE = "zen:external-link-standalone";
// An activation this recent may belong to the incoming link.
const STANDALONE_WINDOW_ACTIVATION_WINDOW_MS = 2000;
// Earlier deactivations are AppKit settling focus, not a user visit.
const STANDALONE_WINDOW_FOCUS_SETTLE_MS = 1500;
// Offset successive panels, wrapping after eight to avoid drifting offscreen.
const STANDALONE_WINDOW_CASCADE_STEP = 28;
const STANDALONE_WINDOW_CASCADE_LENGTH = 8;
// Empty launch command lines can arrive after the URL command line.
const STANDALONE_WINDOW_STRAY_WINDOW_WATCH_MS = 4000;
const STANDALONE_WINDOW_EMPTY_STARTUP_SUPPRESS_MS = 1500;
// Allow a URL-carrying command line to claim an otherwise plain launch.
const STANDALONE_WINDOW_STARTUP_LINK_GRACE_MS = 500;
// Launch activation can arrive after the panel is already visible.
const STANDALONE_WINDOW_LAUNCH_BACKGROUND_SETTLE_MS = [250, 750];
// AppKit orders a closing window out on a later turn.
const STANDALONE_WINDOW_CLOSE_SETTLE_MS = 16;
const STANDALONE_WINDOW_CLOSE_SETTLE_ATTEMPTS = 10;
// A closing panel's key repeat must not close the window underneath it.
const STANDALONE_CLOSE_GESTURE_SUPPRESS_MS = 500;
// The anchor may not have a laid-out width when the picker first opens.
const STANDALONE_WINDOW_SPACE_PICKER_MIN_WIDTH = 120;
const STANDALONE_WINDOW_TOOLBAR_ID = "zen-standalone-window-toolbar";
const STANDALONE_WINDOW_KEEP_CONTROL_ID = "zen-standalone-window-keep";
const STANDALONE_WINDOW_OPEN_IN_SPACE_BUTTON_ID =
  "zen-standalone-window-open-in-space-button";
const STANDALONE_WINDOW_SPACE_PICKER_BUTTON_ID =
  "zen-standalone-window-space-picker-button";
const STANDALONE_WINDOW_SPACE_PICKER_PANEL_ID =
  "PanelUI-zen-standalone-window-spaces";
const STANDALONE_WINDOW_SPACE_PICKER_SEARCH_ID = `${STANDALONE_WINDOW_SPACE_PICKER_PANEL_ID}-search`;
const STANDALONE_WINDOW_SPACE_PICKER_LIST_ID = `${STANDALONE_WINDOW_SPACE_PICKER_PANEL_ID}-list`;
const STANDALONE_WINDOW_SPACE_PICKER_EMPTY_ID = `${STANDALONE_WINDOW_SPACE_PICKER_PANEL_ID}-empty`;
const STANDALONE_WINDOW_SPACE_PICKER_COLLAPSE_ID = `${STANDALONE_WINDOW_SPACE_PICKER_PANEL_ID}-collapse`;
const STANDALONE_WINDOW_GEOMETRY_PREFS = Object.freeze({
  width: "zen.standalone-window.last-width",
  height: "zen.standalone-window.last-height",
  left: "zen.standalone-window.last-screen-x",
  top: "zen.standalone-window.last-screen-y",
});
// These commands operate on spaces, sidebars or tabs that this window cannot own.
const STANDALONE_WINDOW_DISABLED_COMMANDS = [
  "cmd_newNavigator",
  "cmd_newNavigatorTab",
  "cmd_newNavigatorTabNoEvent",
  "cmd_newPrivateWindow",
  "Tools:PrivateBrowsing",
  "Browser:DuplicateTab",
  "Browser:NextTab",
  "Browser:PrevTab",
  "Browser:ShowAllTabs",
  "Browser:AddTabSplitView",
  "Browser:SeparateTabSplitView",
  "Browser:NewUserContextTab",
  "Browser:OpenAboutContainers",
  "Tools:ClassicWindow",
  "History:UndoCloseTab",
  "History:UndoCloseWindow",
  "History:RestoreLastClosedTabOrWindowOrSession",
  "viewBookmarksSidebarKb",
  "viewBookmarksToolbarKb",
  "viewGenaiChatSidebarKb",
  "viewOpenTabsSidebarKb",
  "toggleSidebarKb",
  "key_gotoHistory",
  "key_showAllTabs",
  "key_addTabSplitView",
  "key_separateTabSplitView",
  "key_duplicateTab",
  "key_undoCloseWindow",
  "key_restoreLastClosedTabOrWindowOrSession",
  "key_privatebrowsing",
  "cmd_zenCompactModeToggle",
  "cmd_toggleCompactModeIgnoreHover",
  "cmd_zenCompactModeShowSidebar",
  "cmd_zenToggleSidebar",
  "cmd_zenToggleTabsOnRight",
  "cmd_zenWorkspaceForward",
  "cmd_zenWorkspaceBackward",
  "cmd_zenChangeWorkspaceTab",
  "cmd_zenSplitViewGrid",
  "cmd_zenSplitViewVertical",
  "cmd_zenSplitViewHorizontal",
  "cmd_zenSplitViewUnsplit",
  "cmd_zenNewEmptySplit",
];

export class nsZenStandaloneWindowManager {
  #nextExternalRequestId = 0;
  #standaloneWindows = new Set();
  #emptyStartupSuppressedUntil = 0;
  #startupWindowDeferralUsed = false;
  #deferredStartupWindowTimer = null;
  #deferredStartupWindow = null;
  #inStartupWindowSurvivalArea = false;

  init() {
    void lazy.MacDockSupport;
  }

  createExternalLinkStandaloneWindowRequest({
    uriString,
    options,
    openerWindow,
  }) {
    if (typeof uriString !== "string" || !uriString) {
      return null;
    }

    try {
      Services.io.newURI(uriString);
    } catch {
      return null;
    }

    let isPrivate = false;
    if (typeof options?.isPrivate === "boolean") {
      isPrivate = options.isPrivate;
    } else if (openerWindow) {
      isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(openerWindow);
    }

    const liveOpener =
      !openerWindow?.closed &&
      !openerWindow?.ZenExternalLinkStandalone?.isClosing
        ? openerWindow
        : null;
    return {
      requestId:
        options?.requestId ??
        `zen-external-${Date.now().toString(36)}-${++this.#nextExternalRequestId}`,
      deliverySource: options?.deliverySource ?? "external",
      uriString,
      openerWindow: liveOpener,
      source: "external",
      isPrivate,
      triggeringPrincipal: options?.triggeringPrincipal ?? null,
      referrerInfo: options?.referrerInfo ?? null,
      policyContainer: options?.policyContainer ?? null,
      userContextId: options?.userContextId ?? 0,
      targetRoute:
        options?.targetRoute ?? this.getDefaultKeepTargetRoute(liveOpener),
      broughtApplicationForward: this.wasApplicationJustActivated(),
    };
  }

  wasApplicationJustActivated() {
    const elapsed = lazy.MacDockSupport?.millisecondsSinceApplicationActivated;
    return (
      typeof elapsed === "number" &&
      elapsed >= 0 &&
      elapsed <= STANDALONE_WINDOW_ACTIVATION_WINDOW_MS
    );
  }

  /**
   * @param {object} request - Validated standalone request.
   * @returns {Window|null} The newly constructed browser window.
   */
  constructStandaloneWindow(request) {
    if (AppConstants.platform !== "macosx") {
      return null;
    }

    let nativePanelPrepared = false;
    try {
      const args = Cc["@mozilla.org/supports-string;1"].createInstance(
        Ci.nsISupportsString
      );
      args.data =
        request.source === "global-search" ? "about:blank" : request.uriString;

      Services.zen.prepareStandalonePanel();
      nativePanelPrepared = true;

      const standaloneWindow = lazy.BrowserWindowTracker.openWindow({
        private: request.isPrivate,
        features: this.getStandaloneWindowFeatures(request),
        all: true,
        openerWindow: request.openerWindow,
        args,
        zenSyncedWindow: false,
        zenStandaloneWindow: true,
      });
      if (!standaloneWindow) {
        Services.zen.cancelPreparedStandalonePanel();
        return null;
      }

      standaloneWindow._zenStartupSyncFlag = "unsynced";
      standaloneWindow.ZenExternalLinkStandaloneType =
        ZEN_STANDALONE_WINDOW_TYPE;
      this.makeWindowFollowTheUser(standaloneWindow);
      if (request.userContextId) {
        standaloneWindow._zenStartupUnsyncedUserContextId =
          request.userContextId;
      }
      return standaloneWindow;
    } catch (error) {
      if (nativePanelPrepared) {
        try {
          Services.zen.cancelPreparedStandalonePanel();
        } catch {}
      }
      console.error("Failed to construct Zen standalone window", error);
      return null;
    }
  }

  /**
   * Focuses the native non-activating panel without activating Zen.
   *
   * @param {Window} standaloneWindow - Standalone browser window.
   */
  presentExternalStandaloneWindow(standaloneWindow) {
    try {
      standaloneWindow.focus();
    } catch (error) {
      console.error("Failed to focus a new Zen standalone window", error);
    }
  }

  /**
   * Makes the panel follow the user onto the currently active macOS Space.
   *
   * @param {Window} standaloneWindow - Standalone browser window.
   */
  makeWindowFollowTheUser(standaloneWindow) {
    const dockSupport = lazy.MacDockSupport;
    if (!dockSupport || Services.env.get("MOZ_HEADLESS")) {
      return;
    }

    try {
      const baseWindow = standaloneWindow.docShell.treeOwner.QueryInterface(
        Ci.nsIBaseWindow
      );
      dockSupport.makeWindowJoinActiveSpace(baseWindow);
    } catch (error) {
      console.error(
        "Failed to make a Zen standalone window join the active Space",
        error
      );
    }
  }

  /**
   * Attaches the standalone identity and state to a browser window.
   *
   * @param {Window} standaloneWindow - Newly constructed window.
   * @param {object} request - Validated standalone request.
   * @returns {object} Per-window lifecycle state.
   */
  markWindowAsStandalone(standaloneWindow, request) {
    let resolveReady;
    standaloneWindow.ZenExternalLinkStandaloneReady = false;
    standaloneWindow.ZenExternalLinkStandaloneReadyPromise = new Promise(
      resolve => {
        resolveReady = resolve;
      }
    );
    standaloneWindow.ZenExternalLinkStandaloneType = ZEN_STANDALONE_WINDOW_TYPE;
    standaloneWindow._zenStandaloneWindow = true;

    const state = {
      requestId: request.requestId,
      deliverySource: request.deliverySource,
      source: request.source,
      isPrivate: request.isPrivate,
      uriString: request.uriString,
      openerWindow: request.openerWindow,
      targetRoute: request.targetRoute,
      broughtApplicationForward: request.broughtApplicationForward,
      triggeringPrincipal: request.triggeringPrincipal,
      referrerInfo: request.referrerInfo,
      policyContainer: request.policyContainer,
      userContextId: request.userContextId,
      postData: request.postData ?? null,
      deferredSubmissionLoaded: false,
      toolbar: null,
      isKeeping: false,
      isClosing: false,
      closedTabRecorded: false,
      visitedNormalWindow: false,
      deactivateListener: null,
      commandListener: null,
      initialNormalBounds: null,
      geometryListeners: null,
      resolveReady,
    };
    standaloneWindow.ZenExternalLinkStandalone = state;
    this.#standaloneWindows.add(standaloneWindow);

    const onClosed = subject => {
      if (subject !== standaloneWindow) {
        return;
      }
      standaloneWindow.removeEventListener("unload", onUnload);
      Services.obs.removeObserver(onClosed, "domwindowclosed");
      this.#resolveStandaloneWindowReady(standaloneWindow);
      this.onStandaloneWindowClosed(standaloneWindow);
    };
    const onUnload = event => {
      // Ignore the initial about:blank document being replaced by chrome.
      if (
        event.target.documentURI === "chrome://browser/content/browser.xhtml"
      ) {
        onClosed(standaloneWindow);
      }
    };
    standaloneWindow.addEventListener("unload", onUnload);
    Services.obs.addObserver(onClosed, "domwindowclosed");
    // SSWindowClosing is the last point at which the page is still attached.
    standaloneWindow.addEventListener(
      "SSWindowClosing",
      () => this.onStandaloneWindowClosing(standaloneWindow),
      { once: true }
    );
    return state;
  }

  /**
   * Opens one external URL in a standalone window.
   *
   * @param {object} params - Incoming link context.
   * @param {string} params.uriString - URL to open.
   * @param {object} params.options - Security and container context.
   * @param {Window|null} params.openerWindow - Optional normal-window context.
   * @returns {Window|null} Newly constructed window, or null on failure.
   */
  openExternalLinkStandaloneWindow({
    uriString,
    options = {},
    openerWindow = null,
  }) {
    if (!this.#isEnabled()) {
      return null;
    }

    const request = this.createExternalLinkStandaloneWindowRequest({
      uriString,
      options,
      openerWindow,
    });
    if (!request) {
      return null;
    }

    try {
      return this.#openRequest(request);
    } catch (error) {
      console.error("Could not open standalone window", error);
      return null;
    }
  }

  /**
   * Opens a batch only after every URL has been validated.
   *
   * @param {string[]} uris - URLs to open atomically.
   * @param {Window|null} openerWindow - Optional normal-window context.
   * @param {object} options - Security and launch context.
   * @returns {boolean} Whether every link was handled.
   */
  openExternalLinksInStandaloneWindows(uris, openerWindow, options = {}) {
    if (!this.#isEnabled() || !Array.isArray(uris) || !uris.length) {
      return false;
    }

    const requests = uris.map(uriString =>
      this.createExternalLinkStandaloneWindowRequest({
        uriString,
        options: {
          ...options,
          requestId:
            options.requestId && uris.length == 1
              ? options.requestId
              : undefined,
          deliverySource: options.deliverySource,
        },
        openerWindow,
      })
    );
    if (requests.some(request => !request)) {
      return false;
    }

    const hadDeferredStartupWindow =
      this.isHoldingStartupWindow || !!this.#deferredStartupWindow;
    const keepLaunchInBackground =
      (options.isApplicationLaunch === true || hadDeferredStartupWindow) &&
      Services.prefs.getBoolPref(
        "zen.standalone-window.launch-stays-in-background",
        true
      );
    if (keepLaunchInBackground) {
      this.#handBackLaunchActivation();
    }
    const createdWindows = [];
    for (const request of requests) {
      const standaloneWindow = this.openExternalLinkStandaloneWindow({
        uriString: request.uriString,
        options: {
          ...options,
          requestId: request.requestId,
          deliverySource: request.deliverySource,
          isPrivate: request.isPrivate,
          targetRoute: request.targetRoute,
        },
        openerWindow: request.openerWindow,
      });
      if (!standaloneWindow) {
        for (const createdWindow of createdWindows) {
          const state = createdWindow.ZenExternalLinkStandalone;
          state.isKeeping = true;
          state.isClosing = true;
          createdWindow.skipNextCanClose = true;
          try {
            createdWindow.close();
          } catch (error) {
            console.error("Cannot roll back standalone window", error);
          }
        }
        return false;
      }
      createdWindows.push(standaloneWindow);
    }
    this.#cancelDeferredStartupWindow();
    this.#closeDeferredStartupWindow(createdWindows);
    this.#emptyStartupSuppressedUntil =
      Date.now() + STANDALONE_WINDOW_EMPTY_STARTUP_SUPPRESS_MS;
    if (options.isApplicationLaunch === true || hadDeferredStartupWindow) {
      this.#closeStrayEmptyStartupWindows(createdWindows);
    }
    if (keepLaunchInBackground) {
      this.#settleLaunchInBackground(createdWindows.at(-1));
    }
    return true;
  }

  getStandaloneWindowForURL(uriString) {
    for (const standaloneWindow of this.#standaloneWindows) {
      if (
        !standaloneWindow.closed &&
        standaloneWindow.ZenExternalLinkStandalone?.uriString === uriString
      ) {
        return standaloneWindow;
      }
    }
    return null;
  }

  markStandaloneDocument(standaloneWindow) {
    standaloneWindow.document?.documentElement?.setAttribute(
      "zen-standalone-window",
      "true"
    );
  }

  isStandaloneWindow(standaloneWindow) {
    return (
      !!standaloneWindow?.ZenExternalLinkStandalone &&
      standaloneWindow.ZenExternalLinkStandaloneType ===
        ZEN_STANDALONE_WINDOW_TYPE
    );
  }

  getStandaloneWindowBounds(request = {}) {
    let bounds = Object.fromEntries(
      Object.entries(STANDALONE_WINDOW_GEOMETRY_PREFS).map(([key, pref]) => [
        key,
        Services.prefs.getIntPref(pref, 0),
      ])
    );
    const saved = bounds.width > 0 && bounds.height > 0;
    let area;
    try {
      const manager = Cc["@mozilla.org/gfx/screenmanager;1"].getService(
        Ci.nsIScreenManager
      );
      const screen = saved
        ? manager.screenForRect(
            bounds.left,
            bounds.top,
            bounds.width,
            bounds.height
          )
        : null;
      if (screen || !request.openerWindow?.screen) {
        const values = [{}, {}, {}, {}];
        (screen ?? manager.primaryScreen).GetAvailRectDisplayPix(...values);
        area = Object.fromEntries(
          ["left", "top", "width", "height"].map((key, i) => [
            key,
            values[i].value,
          ])
        );
      }
    } catch (error) {
      console.error("Cannot read standalone screen geometry", error);
    }
    if (!area) {
      const screen = request.openerWindow?.screen;
      area = {
        left: screen?.availLeft ?? 0,
        top: screen?.availTop ?? 0,
        width: screen?.availWidth ?? 1280,
        height: screen?.availHeight ?? 820,
      };
    }
    if (!saved) {
      const width = Math.max(
        1,
        Services.prefs.getIntPref("zen.standalone-window.default-width", 1280)
      );
      const height = Math.max(
        1,
        Services.prefs.getIntPref("zen.standalone-window.default-height", 820)
      );
      bounds = {
        width,
        height,
        left: area.left + Math.max(0, (area.width - width) / 2),
        top: area.top + Math.max(0, (area.height - height) / 2),
      };
    }
    const count = [...Services.wm.getEnumerator(null)].filter(
      win => !win.closed && win._zenStandaloneWindow
    ).length;
    const offset =
      STANDALONE_WINDOW_CASCADE_STEP *
      (count % STANDALONE_WINDOW_CASCADE_LENGTH);
    const width = Math.min(bounds.width, area.width || bounds.width);
    const height = Math.min(bounds.height, area.height || bounds.height);
    return {
      width: Math.round(width),
      height: Math.round(height),
      left: Math.round(
        Math.max(
          area.left,
          Math.min(bounds.left + offset, area.left + area.width - width)
        )
      ),
      top: Math.round(
        Math.max(
          area.top,
          Math.min(bounds.top + offset, area.top + area.height - height)
        )
      ),
    };
  }

  getStandaloneWindowFeatures(request) {
    const { width, height, left, top } =
      this.getStandaloneWindowBounds(request);
    return `width=${width},height=${height},left=${left},top=${top}`;
  }

  canCloseStandaloneWindow(win) {
    try {
      for (const browser of win.gBrowser?.browsers ?? []) {
        if (browser.isConnected && !browser.permitUnload().permitUnload) {
          return false;
        }
      }
      return true;
    } catch (error) {
      console.error("Cannot check standalone unload permission", error);
      return false;
    }
  }

  closeStandaloneWindow(win) {
    const state = win?.ZenExternalLinkStandalone;
    if (!this.isStandaloneWindow(win) || win.closed || state.isClosing) {
      return false;
    }
    if (!win.skipNextCanClose && !this.canCloseStandaloneWindow(win)) {
      return false;
    }
    state.isClosing = true;
    this.#armTrailingCloseGestureSuppression(win);
    win.skipNextCanClose = true;
    try {
      win.close();
      return true;
    } catch (error) {
      state.isClosing = false;
      win.skipNextCanClose = false;
      console.error("Cannot close standalone window", error);
      return false;
    }
  }

  #armTrailingCloseGestureSuppression(win) {
    if (AppConstants.platform !== "macosx") {
      return;
    }
    const windows = [...Services.wm.getEnumerator("navigator:browser")].filter(
      other => other !== win && !other.closed
    );
    const suppress = event => {
      if (
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key?.toLowerCase() === "w"
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    for (const other of windows) {
      other.addEventListener("keydown", suppress, true);
      other.addEventListener("keyup", suppress, true);
    }
    lazy.setTimeout(() => {
      for (const other of windows) {
        other.removeEventListener("keydown", suppress, true);
        other.removeEventListener("keyup", suppress, true);
      }
    }, STANDALONE_CLOSE_GESTURE_SUPPRESS_MS);
  }

  registerStandaloneCommands(win) {
    const state = win.ZenExternalLinkStandalone;
    if (state.commandListener) {
      return;
    }
    state.commandListener = event => {
      const ids = [event.target?.id, event.target?.getAttribute?.("command")];
      if (ids.some(id => id === "cmd_close" || id === "cmd_closeWindow")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.closeStandaloneWindow(win);
      }
    };
    win.document.addEventListener("command", state.commandListener, true);
  }

  disableStandaloneWorkspaceCommands(win) {
    for (const id of STANDALONE_WINDOW_DISABLED_COMMANDS) {
      win.document.getElementById(id)?.setAttribute("disabled", "true");
    }
  }

  registerStandaloneShortcuts(win) {
    const state = win.ZenExternalLinkStandalone;
    if (state.keydownListener) {
      return;
    }
    state.keydownListener = event => {
      const accel =
        AppConstants.platform === "macosx" ? event.metaKey : event.ctrlKey;
      if (!accel || event.altKey) {
        return;
      }
      const key = event.key?.toLowerCase();
      const blocked =
        (!event.shiftKey && ["w", "t", "b", "o"].includes(key)) ||
        (event.shiftKey && key === "p");
      if (!blocked) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (key === "w") {
        this.closeStandaloneWindow(win);
      } else if (key === "o") {
        this.onOpenInDefaultSpaceCommand(win);
      }
    };
    win.addEventListener("keydown", state.keydownListener, true);
  }

  #readNormalStandaloneWindowBounds(win) {
    if (!win || win.windowState !== win.STATE_NORMAL) {
      return null;
    }
    try {
      const bounds = {
        width: Math.round(win.outerWidth),
        height: Math.round(win.outerHeight),
        left: Math.round(win.screenX),
        top: Math.round(win.screenY),
      };
      return Object.values(bounds).every(Number.isFinite) &&
        bounds.width > 0 &&
        bounds.height > 0
        ? bounds
        : null;
    } catch {
      return null;
    }
  }

  registerStandaloneWindowGeometry(win) {
    const state = win.ZenExternalLinkStandalone;
    if (state.geometryListeners) {
      return;
    }
    state.initialNormalBounds = this.#readNormalStandaloneWindowBounds(win);
    const persist = () => this.persistStandaloneWindowGeometry(win);
    state.geometryListeners = [
      [win, "resize", persist],
      [win, "sizemodechange", persist],
      [win.windowRoot, "MozUpdateWindowPos", persist],
    ];
    for (const [target, type, listener] of state.geometryListeners) {
      target.addEventListener(type, listener);
    }
  }

  persistStandaloneWindowGeometry(win) {
    const bounds = this.#readNormalStandaloneWindowBounds(win);
    const initial = win?.ZenExternalLinkStandalone?.initialNormalBounds;
    if (
      !bounds ||
      (initial &&
        Object.keys(bounds).every(key => bounds[key] === initial[key]))
    ) {
      return false;
    }
    for (const [key, pref] of Object.entries(
      STANDALONE_WINDOW_GEOMETRY_PREFS
    )) {
      Services.prefs.setIntPref(pref, bounds[key]);
    }
    return true;
  }

  onStandaloneWindowClosing(win) {
    this.persistStandaloneWindowGeometry(win);
    const state = win.ZenExternalLinkStandalone;
    if (state) {
      state.isClosing = true;
    }
    if (!state || state.isKeeping || state.closedTabRecorded) {
      return;
    }
    this.#armTrailingCloseGestureSuppression(win);
    const tab = win.gBrowser?.selectedTab;
    const target = this.getStandaloneArchiveTargetWindow(win);
    let result = {
      ok: false,
      reason: !tab ? "source-tab-missing" : "target-window-missing",
    };
    try {
      if (tab && target) {
        result = lazy.SessionStore.recordClosedTabForOtherWindow(target, tab);
      }
    } catch (error) {
      console.error("Cannot archive standalone page", error);
      result = { ok: false, reason: "archive-failed" };
    }
    if (result.ok) {
      state.closedTabRecorded = true;
    } else {
      console.error(
        `[ZenStandalone] archive=${JSON.stringify({ requestId: state.requestId, ...result })}`
      );
    }
  }

  getStandaloneArchiveTargetWindow(win) {
    const isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
    // Archive capture can precede workspace startup; __SSi is sufficient.
    return (
      [
        win.ZenExternalLinkStandalone?.openerWindow,
        ...lazy.BrowserWindowTracker.orderedWindows,
      ].find(
        target =>
          target &&
          !target.closed &&
          target !== win &&
          !target._zenStandaloneWindow &&
          target.gBrowser &&
          target.__SSi &&
          lazy.PrivateBrowsingUtils.isWindowPrivate(target) === isPrivate
      ) ?? null
    );
  }

  onStandaloneWindowClosed(win) {
    const state = win.ZenExternalLinkStandalone;
    this.#standaloneWindows.delete(win);
    if (!state) {
      return;
    }
    this.persistStandaloneWindowGeometry(win);
    for (const [target, type, listener] of state.geometryListeners ?? []) {
      target.removeEventListener(type, listener);
    }
    state.geometryListeners = null;
    this.cleanupStandaloneToolbar(win);
    win.ZenExternalLinkStandalone = null;
    if (!state.isKeeping) {
      this.maybeReturnFocusToPreviousApplication(win, state);
    }
  }

  cleanupStandaloneToolbar(win) {
    const state = win.ZenExternalLinkStandalone;
    if (!state) {
      return;
    }
    for (const [property, target, type] of [
      ["deactivateListener", win, "deactivate"],
      ["keydownListener", win, "keydown"],
      ["commandListener", win.document, "command"],
    ]) {
      if (state[property]) {
        target.removeEventListener(type, state[property], true);
        state[property] = null;
      }
    }
    state.pickerCleanup?.();
    for (const [target, type, listener] of state.toolbar?.listeners ?? []) {
      target.removeEventListener(type, listener);
    }
    state.toolbar?.root.remove();
    state.toolbar = null;
  }

  hasOtherStandaloneWindows(win) {
    return [
      ...new Set([
        ...this.#standaloneWindows,
        ...Services.wm.getEnumerator(null),
      ]),
    ].some(
      other =>
        other !== win &&
        !other.closed &&
        other._zenStandaloneWindow &&
        !other.ZenExternalLinkStandalone?.isClosing
    );
  }

  watchForNormalWindowVisits(win) {
    const state = win.ZenExternalLinkStandalone;
    const readyAt = Date.now();
    state.deactivateListener = () => {
      // FocusManager receives the newly active window on the next turn.
      Services.tm.dispatchToMainThread(() => {
        if (
          win.closed ||
          !win.ZenExternalLinkStandalone ||
          Date.now() - readyAt < STANDALONE_WINDOW_FOCUS_SETTLE_MS
        ) {
          return;
        }
        const active = Services.focus.activeWindow;
        if (
          active &&
          active !== win &&
          active.gBrowser &&
          !active._zenStandaloneWindow
        ) {
          state.visitedNormalWindow = true;
        }
      });
    };
    win.addEventListener("deactivate", state.deactivateListener, true);
  }

  maybeReturnFocusToPreviousApplication(win, state) {
    if (
      !lazy.MacDockSupport ||
      !state.broughtApplicationForward ||
      state.visitedNormalWindow ||
      this.hasOtherStandaloneWindows(win) ||
      !Services.prefs.getBoolPref(
        "zen.standalone-window.return-focus-on-close",
        true
      )
    ) {
      return;
    }
    try {
      lazy.MacDockSupport.activatePreviousApplication();
    } catch (error) {
      console.error(
        "Cannot return standalone focus to the previous application",
        error
      );
    }
  }

  getDefaultKeepTargetRoute(win) {
    return win?.gZenWorkspaces?.workspaceEnabled
      ? win.gZenWorkspaces.activeWorkspace || null
      : null;
  }

  canKeepStandaloneUrlInWindow(win) {
    return (
      !!win &&
      !win.closed &&
      !win._zenStandaloneWindow &&
      !!win.gBrowser &&
      !!win.gZenWorkspaces?.workspaceEnabled
    );
  }

  getStandaloneKeepTargetWindow(win) {
    const candidates = [
      win.ZenExternalLinkStandalone?.openerWindow,
      ...lazy.BrowserWindowTracker.orderedWindows,
    ];
    const isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
    return (
      candidates.find(
        target =>
          this.canKeepStandaloneUrlInWindow(target) &&
          lazy.PrivateBrowsingUtils.isWindowPrivate(target) === isPrivate
      ) ?? null
    );
  }

  resolveKeepTargetRoute(win, route) {
    return route ?? win.ZenExternalLinkStandalone?.targetRoute ?? null;
  }

  resolveKeepTargetSpace(win) {
    const route = this.resolveKeepTargetRoute(win);
    for (const target of [
      this.getStandaloneKeepTargetWindow(win),
      win.ZenExternalLinkStandalone?.openerWindow,
    ]) {
      if (target && !target.closed) {
        const spaces = target.gZenWorkspaces;
        const space =
          (route && spaces?.getWorkspaceFromId(route)) ||
          spaces?.getActiveWorkspaceFromCache();
        if (space) {
          return space;
        }
      }
    }
    return null;
  }

  keepStandaloneWindowInSpace(win, targetRoute) {
    const state = win?.ZenExternalLinkStandalone;
    if (
      !this.isStandaloneWindow(win) ||
      win.closed ||
      state.isKeeping ||
      state.isClosing
    ) {
      return false;
    }
    const target = this.getStandaloneKeepTargetWindow(win);
    if (!target) {
      return this.keepStandaloneWindowInNewWindow(win, targetRoute);
    }
    const route = this.resolveKeepTargetRoute(win, targetRoute);
    const workspace = route
      ? target.gZenWorkspaces.getWorkspaceFromId(route)
      : null;
    if (route && !workspace) {
      return false;
    }
    state.isKeeping = true;
    try {
      let tab = this.adoptStandaloneTab(win, target, workspace);
      if (!tab) {
        // A reload fallback unloads the original page. Ask before creating a
        // second copy, then let the close funnel reuse that permission.
        if (!this.canCloseStandaloneWindow(win)) {
          state.isKeeping = false;
          return false;
        }
        tab = this.reopenStandaloneUrlInSpace(win, target, workspace);
        if (tab) {
          win.skipNextCanClose = true;
        }
      }
      if (!tab) {
        state.isKeeping = false;
        return false;
      }
      // Close before reveal: while this panel is visible, activating Zen keeps
      // the user on its Space instead of following the destination window.
      if (!win.closed && !this.closeStandaloneWindow(win)) {
        state.isKeeping = false;
        return false;
      }
      this.#revealKeptTab(target, tab, workspace, win).catch(console.error);
      return true;
    } catch (error) {
      state.isKeeping = false;
      console.error("Cannot keep standalone page", error);
      return false;
    }
  }

  keepStandaloneWindowInNewWindow(win, route) {
    const state = win.ZenExternalLinkStandalone;
    state.isKeeping = true;
    let target;
    try {
      target = lazy.BrowserWindowTracker.openWindow({
        private: lazy.PrivateBrowsingUtils.isWindowPrivate(win),
      });
    } catch (error) {
      console.error("Cannot open standalone keep destination", error);
    }
    if (!target) {
      state.isKeeping = false;
      return false;
    }
    this.#promiseDelayedStartup(target)
      .then(async () => {
        if (target.closed || win.closed) {
          return false;
        }
        await target.gZenWorkspaces?.promiseInitialized;
        if (
          target.closed ||
          win.closed ||
          !this.canKeepStandaloneUrlInWindow(target)
        ) {
          return false;
        }
        state.isKeeping = false;
        return this.keepStandaloneWindowInSpace(win, route);
      })
      .catch(error => {
        console.error("Cannot initialize standalone keep destination", error);
        return false;
      })
      .then(kept => {
        if (!kept) {
          state.isKeeping = false;
          this.#enableToolbar(state.toolbar?.root);
        }
      });
    return true;
  }

  adoptStandaloneTab(win, target, workspace) {
    if (win.gBrowser?.tabs.length !== 1) {
      return null;
    }
    return (
      target.gBrowser.adoptTab(win.gBrowser.tabs[0], {
        tabIndex: target.gBrowser.tabs.length,
        selectTab: true,
        spaceId: workspace?.uuid ?? null,
      }) ?? null
    );
  }

  reopenStandaloneUrlInSpace(win, target, workspace) {
    const state = win.ZenExternalLinkStandalone;
    const uriString =
      win.gBrowser?.selectedBrowser?.currentURI?.spec ?? state.uriString;
    if (!uriString) {
      return null;
    }
    return (
      target.gBrowser.addTab(uriString, {
        inBackground: false,
        skipRoute: true,
        triggeringPrincipal:
          state.triggeringPrincipal ??
          Services.scriptSecurityManager.createNullPrincipal({}),
        referrerInfo: state.referrerInfo ?? undefined,
        policyContainer: state.policyContainer ?? undefined,
        userContextId: workspace?.containerTabId ?? state.userContextId,
        zenWorkspaceId: workspace?.uuid,
      }) ?? null
    );
  }

  async #revealKeptTab(target, tab, workspace, win) {
    if (target.closed || tab.closing) {
      return;
    }
    if (workspace) {
      target.gZenWorkspaces.moveTabToWorkspace(tab, workspace.uuid);
      if (target.gZenWorkspaces.activeWorkspace !== workspace.uuid) {
        await target.gZenWorkspaces.changeWorkspace(workspace);
      }
    }
    if (target.closed || tab.closing) {
      return;
    }
    target.gBrowser.selectedTab = tab;
    for (
      let i = 0;
      !win.closed && i < STANDALONE_WINDOW_CLOSE_SETTLE_ATTEMPTS;
      i++
    ) {
      await new Promise(resolve =>
        lazy.setTimeout(resolve, STANDALONE_WINDOW_CLOSE_SETTLE_MS)
      );
    }
    if (target.closed || tab.closing) {
      return;
    }
    // Ordering a normal window front without activation leaves the user on
    // the old Space. Promotion alone activates all windows, then focuses the
    // destination so macOS can follow it to its Space.
    try {
      lazy.MacDockSupport?.activateApplication(true);
    } catch (error) {
      console.error("Cannot activate Zen for a kept page", error);
    }
    target.focus();
  }

  onOpenInDefaultSpaceCommand(win) {
    const toolbar = win.ZenExternalLinkStandalone?.toolbar?.root;
    return toolbar
      ? this.#runToolbarCommand(toolbar, () =>
          this.keepStandaloneWindowInSpace(win)
        )
      : this.keepStandaloneWindowInSpace(win);
  }

  onOpenInSelectedSpaceCommand(win, route) {
    const toolbar = win.ZenExternalLinkStandalone?.toolbar?.root;
    return toolbar
      ? this.#runToolbarCommand(toolbar, () =>
          this.keepStandaloneWindowInSpace(win, route)
        )
      : this.keepStandaloneWindowInSpace(win, route);
  }

  #enableToolbar(toolbar) {
    for (const button of toolbar?.querySelectorAll('[role="button"]') ?? []) {
      button.removeAttribute("disabled");
    }
  }

  #runToolbarCommand(toolbar, command) {
    if (toolbar.querySelector('[role="button"][disabled]')) {
      return false;
    }
    for (const button of toolbar.querySelectorAll('[role="button"]')) {
      button.setAttribute("disabled", "true");
    }
    let handled = false;
    try {
      handled = !!command();
      return handled;
    } finally {
      if (!handled) {
        this.#enableToolbar(toolbar);
      }
    }
  }

  getKeepShortcutLabel() {
    return AppConstants.platform === "macosx" ? "⌘O" : "Ctrl+O";
  }

  relocateStandaloneWindowButtons(win) {
    const document = win.document;
    const container = document.getElementById(
      "zen-appcontent-navbar-container"
    );
    const buttons =
      win.gZenUIManager?.actualWindowButtons ??
      document.querySelector(".titlebar-buttonbox-container");

    // Controls already in the navbar do not need moving.
    if (!container || !buttons || !buttons.closest("#navigator-toolbox")) {
      return;
    }

    container.prepend(buttons);
    container.setAttribute("zen-standalone-window-has-buttons", "true");
  }

  insertStandaloneToolbar(win, toolbar) {
    const nav = win.document.getElementById("nav-bar");
    const buttons = nav?.querySelector(
      ":scope > .titlebar-buttonbox-container"
    );
    if (buttons) {
      nav.insertBefore(toolbar, buttons);
      return true;
    }
    const container = win.document.getElementById(
      "zen-appcontent-navbar-container"
    );
    if (!container) {
      console.error("Standalone toolbar has no navbar container");
      return false;
    }
    container.append(toolbar);
    return true;
  }

  initializeStandaloneToolbar(win) {
    const state = win.ZenExternalLinkStandalone;
    if (state.toolbar) {
      return;
    }
    this.relocateStandaloneWindowButtons(win);
    const document = win.document;
    const listeners = [];
    const makeBox = id => {
      const box = document.createXULElement("hbox");
      box.id = id;
      box.setAttribute("align", "center");
      return box;
    };
    const root = makeBox(STANDALONE_WINDOW_TOOLBAR_ID);
    const keepControl = makeBox(STANDALONE_WINDOW_KEEP_CONTROL_ID);
    root.append(keepControl);
    const makeButton = (id, command) => {
      const button = makeBox(id);
      button.setAttribute("role", "button");
      button.setAttribute("tabindex", "0");
      const activate = event => {
        if (
          button.hasAttribute("disabled") ||
          (event.type === "click" && event.button !== 0) ||
          (event.type === "keydown" && !["Enter", " "].includes(event.key))
        ) {
          return;
        }
        event.preventDefault();
        command();
      };
      for (const type of ["click", "keydown"]) {
        button.addEventListener(type, activate);
        listeners.push([button, type, activate]);
      }
      keepControl.append(button);
      return button;
    };
    // Plain boxes allow independently styled prefix, space and shortcut labels.
    const openInSpaceButton = makeButton(
      STANDALONE_WINDOW_OPEN_IN_SPACE_BUTTON_ID,
      () => this.onOpenInDefaultSpaceCommand(win)
    );
    const labels = ["keep-prefix", "keep-space", "shortcut"].map(name => {
      const label = document.createXULElement("label");
      label.className = `zen-standalone-window-${name}`;
      openInSpaceButton.append(label);
      return label;
    });
    document.l10n.setAttributes(labels[0], "zen-standalone-window-open-in");
    labels[2].setAttribute("value", this.getKeepShortcutLabel());
    const space = this.resolveKeepTargetSpace(win);
    if (space?.name) {
      labels[1].setAttribute("value", space.name);
      document.l10n.setAttributes(
        openInSpaceButton,
        "zen-standalone-window-keep-tooltip",
        { space: space.name }
      );
    } else {
      document.l10n.setAttributes(
        labels[1],
        "zen-standalone-window-generic-space"
      );
      document.l10n.setAttributes(
        openInSpaceButton,
        "zen-standalone-window-keep-tooltip-generic"
      );
    }
    const spacePickerButton = makeButton(
      STANDALONE_WINDOW_SPACE_PICKER_BUTTON_ID,
      () => this.openStandaloneSpacePicker(win)
    );
    document.l10n.setAttributes(
      spacePickerButton,
      "zen-standalone-window-choose-space"
    );
    const chevron = document.createXULElement("image");
    chevron.className = "zen-standalone-window-chevron";
    spacePickerButton.append(chevron);
    if (!this.insertStandaloneToolbar(win, root)) {
      for (const [target, type, listener] of listeners) {
        target.removeEventListener(type, listener);
      }
      return;
    }
    state.toolbar = {
      root,
      keepControl,
      openInSpaceButton,
      spacePickerButton,
      listeners,
    };
  }

  openStandaloneSpacePicker(win) {
    const state = win?.ZenExternalLinkStandalone;
    if (!state || win.closed || state.isKeeping || state.isClosing) {
      return false;
    }
    const document = win.document;
    const panel = document.getElementById(
      STANDALONE_WINDOW_SPACE_PICKER_PANEL_ID
    );
    const list = document.getElementById(
      STANDALONE_WINDOW_SPACE_PICKER_LIST_ID
    );
    const search = document.getElementById(
      STANDALONE_WINDOW_SPACE_PICKER_SEARCH_ID
    );
    const anchor = state.toolbar?.keepControl;
    const target = this.getStandaloneKeepTargetWindow(win);
    if (!panel || !list || !search || !anchor || !target) {
      return false;
    }
    if (panel.state === "open" || panel.state === "showing") {
      return true;
    }
    state.pickerCleanup?.();
    this.populateStandaloneSpacePicker(
      list,
      target.gZenWorkspaces.getWorkspaces(),
      target
    );
    search.value = "";
    this.filterStandaloneSpacePicker(list, "");
    const listeners = [
      [
        panel,
        "command",
        event => {
          if (event.target?.id === STANDALONE_WINDOW_SPACE_PICKER_COLLAPSE_ID) {
            panel.hidePopup();
            return;
          }
          const row = event.target?.closest?.("[zen-workspace-id]");
          if (row && !row.hidden) {
            panel.hidePopup();
            this.onOpenInSelectedSpaceCommand(
              win,
              row.getAttribute("zen-workspace-id")
            );
          }
        },
      ],
      [
        search,
        "input",
        () => this.filterStandaloneSpacePicker(list, search.value),
      ],
      [
        search,
        "keydown",
        event => {
          if (event.key === "Enter") {
            event.preventDefault();
            [...list.children].find(row => !row.hidden)?.doCommand();
          }
        },
      ],
      [panel, "popupshown", () => search.focus({ preventScroll: true })],
    ];
    const cleanup = () => {
      for (const [element, type, handler] of listeners) {
        element.removeEventListener(type, handler);
      }
      panel.removeEventListener("popuphidden", cleanup);
      state.pickerCleanup = null;
    };
    state.pickerCleanup = cleanup;
    for (const [element, type, handler] of listeners) {
      element.addEventListener(type, handler);
    }
    panel.addEventListener("popuphidden", cleanup, { once: true });
    const rect = anchor.getBoundingClientRect();
    panel.style.setProperty(
      "--panel-width",
      `${Math.max(Math.round(rect.width), STANDALONE_WINDOW_SPACE_PICKER_MIN_WIDTH)}px`
    );
    panel.style.setProperty(
      "--zen-standalone-window-picker-anchor-height",
      `${Math.round(rect.height)}px`
    );
    try {
      panel.openPopup(
        anchor,
        "after_end",
        0,
        -Math.round(rect.height),
        false,
        false
      );
      return true;
    } catch (error) {
      cleanup();
      console.error("Cannot open standalone space picker", error);
      return false;
    }
  }

  populateStandaloneSpacePicker(list, workspaces, target) {
    const document = list.ownerDocument;
    list.replaceChildren();
    for (const workspace of workspaces) {
      const row = document.createXULElement("toolbarbutton");
      row.className = "subviewbutton zen-standalone-window-space-row";
      row.setAttribute("zen-workspace-id", workspace.uuid);
      row.setAttribute("zen-workspace-name", workspace.name ?? "");
      if (workspace.uuid === target.gZenWorkspaces.activeWorkspace) {
        row.setAttribute("active", "true");
      }
      // Supplying children keeps MozToolbarbutton from creating a second label.
      const tile = document.createXULElement("hbox");
      tile.className = "zen-standalone-window-space-icon";
      tile.setAttribute("align", "center");
      tile.setAttribute("pack", "center");
      const accent = this.getStandaloneWorkspaceAccent(target, workspace);
      if (accent) {
        tile.style.setProperty("--zen-standalone-window-space-accent", accent);
      }
      const isImage = workspace.icon?.endsWith(".svg");
      const icon = document.createXULElement(isImage ? "image" : "label");
      icon.className = `zen-standalone-window-space-icon-${isImage ? "image" : "glyph"}`;
      icon.setAttribute(
        isImage ? "src" : "value",
        workspace.icon ||
          (workspace.name?.trim().charAt(0) || "?").toUpperCase()
      );
      tile.append(icon);
      const name = document.createXULElement("label");
      name.className = "zen-standalone-window-space-name";
      name.setAttribute("value", workspace.name ?? "");
      name.setAttribute("crop", "end");
      name.setAttribute("flex", "1");
      row.append(tile, name);
      list.append(row);
    }
  }

  getStandaloneWorkspaceAccent(target, workspace) {
    try {
      return (
        target.gZenThemePicker?.getGradientForWorkspace(workspace, {
          getGradient: false,
        })?.primaryColor ?? null
      );
    } catch (error) {
      console.error("Cannot read standalone space accent", error);
      return null;
    }
  }

  filterStandaloneSpacePicker(list, query) {
    const needle = (query ?? "").trim().toLowerCase();
    let matches = 0;
    for (const row of list.children) {
      row.hidden =
        !!needle &&
        !row.getAttribute("zen-workspace-name").toLowerCase().includes(needle);
      matches += !row.hidden;
    }
    const empty = list.ownerDocument.getElementById(
      STANDALONE_WINDOW_SPACE_PICKER_EMPTY_ID
    );
    if (empty) {
      empty.hidden = matches > 0;
    }
  }

  shouldSuppressEmptyStartupWindow() {
    return this.#isEnabled() && Date.now() < this.#emptyStartupSuppressedUntil;
  }

  get isHoldingStartupWindow() {
    return this.#deferredStartupWindowTimer !== null;
  }

  deferStartupWindowForExternalLink(openStartupWindow) {
    if (
      !this.#isEnabled() ||
      this.#startupWindowDeferralUsed ||
      typeof openStartupWindow !== "function" ||
      lazy.PrivateBrowsingUtils.permanentPrivateBrowsing
    ) {
      return false;
    }
    const grace = Services.prefs.getIntPref(
      "zen.standalone-window.startup-link-grace-ms",
      STANDALONE_WINDOW_STARTUP_LINK_GRACE_MS
    );
    if (grace <= 0) {
      return false;
    }
    // There may be no native window at all during this wait.
    try {
      Services.startup.enterLastWindowClosingSurvivalArea();
      this.#inStartupWindowSurvivalArea = true;
    } catch (error) {
      console.error("Cannot hold Zen open for startup link delivery", error);
      return false;
    }
    this.#startupWindowDeferralUsed = true;
    try {
      this.#deferredStartupWindowTimer = lazy.setTimeout(() => {
        this.#deferredStartupWindowTimer = null;
        try {
          if (
            Services.startup.shuttingDown ||
            Services.wm.getMostRecentWindow("navigator:browser")
          ) {
            return;
          }
          const win = openStartupWindow();
          if (!win || win.closed) {
            return;
          }
          this.#deferredStartupWindow = win;
          win._zenDeferredStartupWindow = true;
          this.#promiseDelayedStartup(win)
            .then(() => {
              // A fully started normal window belongs to the user, even if empty.
              delete win._zenDeferredStartupWindow;
              if (this.#deferredStartupWindow === win) {
                this.#deferredStartupWindow = null;
              }
            })
            .catch(console.error);
        } catch (error) {
          console.error("Cannot open deferred startup window", error);
        } finally {
          this.#exitStartupWindowSurvivalArea();
        }
      }, grace);
    } catch (error) {
      this.#exitStartupWindowSurvivalArea();
      console.error("Cannot schedule deferred startup window", error);
      return false;
    }
    return true;
  }

  #exitStartupWindowSurvivalArea() {
    if (this.#inStartupWindowSurvivalArea) {
      this.#inStartupWindowSurvivalArea = false;
      try {
        Services.startup.exitLastWindowClosingSurvivalArea();
      } catch (error) {
        console.error("Cannot release startup survival area", error);
      }
    }
  }

  #cancelDeferredStartupWindow() {
    if (this.isHoldingStartupWindow) {
      lazy.clearTimeout(this.#deferredStartupWindowTimer);
      this.#deferredStartupWindowTimer = null;
      this.#exitStartupWindowSurvivalArea();
    }
  }

  #isStrayStartupWindow(win, excluded) {
    if (
      !win ||
      win.closed ||
      win._zenStandaloneWindow ||
      win.gZenStartup?.isReady ||
      win.gBrowserInit?.delayedStartupFinished ||
      excluded.some(
        other =>
          other === win ||
          (other.browsingContext &&
            other.browsingContext === win.browsingContext)
      ) ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(win)
    ) {
      return false;
    }
    return (
      win.gBrowser?.tabs.length === 1 &&
      win.gBrowser.tabs[0].hasAttribute("zen-empty-tab")
    );
  }

  #closeDeferredStartupWindow(created) {
    const win = this.#deferredStartupWindow;
    this.#deferredStartupWindow = null;
    if (this.#isStrayStartupWindow(win, created)) {
      try {
        win.skipNextCanClose = true;
        win.close();
      } catch (error) {
        console.error("Cannot close deferred startup window", error);
      }
    }
  }

  #closeStrayEmptyStartupWindows(excluded) {
    const check = win => {
      if (!this.#isStrayStartupWindow(win, excluded)) {
        return;
      }
      Services.tm.dispatchToMainThread(() => {
        // Startup or navigation may have completed since the first check.
        if (this.#isStrayStartupWindow(win, excluded)) {
          try {
            win.skipNextCanClose = true;
            win.close();
          } catch (error) {
            console.error("Cannot close stray startup window", error);
          }
        }
      });
    };
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      check(win);
    }
    const pending = new Map();
    const observer = (win, topic) => {
      if (topic !== "domwindowopened") {
        return;
      }
      const loaded = () => {
        pending.delete(win);
        check(win);
      };
      pending.set(win, loaded);
      win.addEventListener("load", loaded, { once: true });
    };
    Services.ww.registerNotification(observer);
    lazy.setTimeout(() => {
      Services.ww.unregisterNotification(observer);
      for (const [win, loaded] of pending) {
        win.removeEventListener("load", loaded);
      }
      pending.clear();
    }, STANDALONE_WINDOW_STRAY_WINDOW_WATCH_MS);
  }

  #handBackLaunchActivation(win = null) {
    try {
      lazy.MacDockSupport?.activatePreviousApplication();
      if (win && !win.closed) {
        win.focus();
      }
    } catch (error) {
      console.error("Cannot return launch activation", error);
    }
  }

  #settleLaunchInBackground(win) {
    for (const delay of STANDALONE_WINDOW_LAUNCH_BACKGROUND_SETTLE_MS) {
      lazy.setTimeout(() => {
        if (
          !win.closed &&
          !win.ZenExternalLinkStandalone?.isKeeping &&
          !win.ZenExternalLinkStandalone?.visitedNormalWindow &&
          lazy.MacDockSupport?.isApplicationActive
        ) {
          this.#handBackLaunchActivation(win);
        }
      }, delay);
    }
  }

  #logExternalRequest(request, phase, reason = "") {
    Services.console.logStringMessage(
      `[ZenStandalone] request=${request.requestId} phase=${phase} source=${request.deliverySource ?? request.source} private=${!!request.isPrivate} container=${request.userContextId ?? 0} reason=${reason}`
    );
  }

  createGlobalSearchStandaloneWindowRequest(options) {
    const request = this.createExternalLinkStandaloneWindowRequest({
      uriString: options.uriString,
      options: { ...options, isPrivate: false },
      openerWindow: null,
    });
    return request
      ? {
          ...request,
          source: "global-search",
          deliverySource: "global-search",
          postData: options.postData ?? null,
          broughtApplicationForward: true,
        }
      : null;
  }

  openGlobalSearchResultInStandalone(options) {
    if (
      !this.#isEnabled() ||
      lazy.PrivateBrowsingUtils.permanentPrivateBrowsing
    ) {
      return null;
    }
    const request = this.createGlobalSearchStandaloneWindowRequest(options);
    return request ? this.#openRequest(request) : null;
  }

  #loadDeferredGlobalSearchSubmission(win) {
    const state = win.ZenExternalLinkStandalone;
    if (state.source !== "global-search" || state.deferredSubmissionLoaded) {
      return;
    }
    win.gBrowser.selectedBrowser.loadURI(Services.io.newURI(state.uriString), {
      triggeringPrincipal:
        state.triggeringPrincipal ??
        Services.scriptSecurityManager.createNullPrincipal({}),
      referrerInfo: state.referrerInfo,
      policyContainer: state.policyContainer,
      postData: state.postData,
    });
    state.deferredSubmissionLoaded = true;
  }

  #isEnabled() {
    return (
      AppConstants.platform === "macosx" &&
      Services.prefs.getBoolPref("zen.standalone-window.enabled", false)
    );
  }

  #openRequest(request) {
    this.#logExternalRequest(request, "validated");
    const standaloneWindow = this.constructStandaloneWindow(request);
    if (!standaloneWindow) {
      this.#logExternalRequest(request, "failed", "native-create");
      return null;
    }
    this.#logExternalRequest(request, "native-created");
    this.markWindowAsStandalone(standaloneWindow, request);
    this.presentExternalStandaloneWindow(standaloneWindow);

    this.#initializeStandaloneWindow(standaloneWindow).catch(error => {
      this.#logExternalRequest(request, "failed", "initialization");
      console.error("Could not initialize standalone window", error);
      this.#resolveStandaloneWindowReady(standaloneWindow);
    });
    return standaloneWindow;
  }

  async #initializeStandaloneWindow(standaloneWindow) {
    await this.#promiseDelayedStartup(standaloneWindow);
    if (standaloneWindow.closed || !this.isStandaloneWindow(standaloneWindow)) {
      this.#resolveStandaloneWindowReady(standaloneWindow);
      return;
    }

    if (AppConstants.platform === "macosx") {
      const baseWindow = standaloneWindow.docShell.treeOwner.QueryInterface(
        Ci.nsIBaseWindow
      );
      if (!Services.zen.isStandalonePanel(baseWindow)) {
        const state = standaloneWindow.ZenExternalLinkStandalone;
        state.isKeeping = true;
        state.isClosing = true;
        standaloneWindow.skipNextCanClose = true;
        standaloneWindow.close();
        this.#resolveStandaloneWindowReady(standaloneWindow);
        throw new Error(
          "Refusing to initialize a standalone window without its native panel"
        );
      }
    }

    this.markStandaloneDocument(standaloneWindow);
    // Close ownership is a lifecycle rule, even if building the toolbar fails.
    this.registerStandaloneCommands(standaloneWindow);
    this.registerStandaloneShortcuts(standaloneWindow);
    this.disableStandaloneWorkspaceCommands(standaloneWindow);
    this.registerStandaloneWindowGeometry(standaloneWindow);
    this.watchForNormalWindowVisits(standaloneWindow);
    this.initializeStandaloneToolbar(standaloneWindow);
    this.#loadDeferredGlobalSearchSubmission(standaloneWindow);
    this.#logExternalRequest(
      standaloneWindow.ZenExternalLinkStandalone,
      "initialized"
    );
    // Browser chrome can update fullscreen collection flags after creation.
    this.makeWindowFollowTheUser(standaloneWindow);
    this.#resolveStandaloneWindowReady(standaloneWindow);
  }

  #promiseDelayedStartup(standaloneWindow) {
    if (
      standaloneWindow.closed ||
      standaloneWindow.gBrowserInit?.delayedStartupFinished
    ) {
      return Promise.resolve();
    }

    return new Promise(resolve => {
      const observe = subject => {
        if (subject != standaloneWindow) {
          return;
        }
        Services.obs.removeObserver(
          observe,
          "browser-delayed-startup-finished"
        );
        Services.obs.removeObserver(observe, "domwindowclosed");
        resolve();
      };
      Services.obs.addObserver(observe, "browser-delayed-startup-finished");
      Services.obs.addObserver(observe, "domwindowclosed");
    });
  }

  #resolveStandaloneWindowReady(standaloneWindow) {
    if (standaloneWindow.ZenExternalLinkStandaloneReady) {
      return;
    }
    standaloneWindow.ZenExternalLinkStandaloneReady = true;
    const state = standaloneWindow.ZenExternalLinkStandalone;
    state?.resolveReady?.(standaloneWindow);
    if (state) {
      delete state.resolveReady;
    }
    if (!standaloneWindow.closed) {
      standaloneWindow.dispatchEvent(
        new standaloneWindow.CustomEvent("zen-standalone-window-ready")
      );
    }
  }
}

export const gZenStandaloneWindowManager = new nsZenStandaloneWindowManager();

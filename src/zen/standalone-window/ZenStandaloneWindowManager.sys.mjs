/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "MacDockSupport", () => {
  if (AppConstants.platform !== "macosx") {
    return null;
  }
  return Cc["@mozilla.org/widget/macdocksupport;1"].getService(
    Ci.nsIMacDockSupport,
  );
});

export const ZEN_STANDALONE_WINDOW_TYPE = "zen:external-link-standalone";

export class nsZenStandaloneWindowManager {
  #nextExternalRequestId = 0;
  #standaloneWindows = new Set();

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
      targetRoute: null,
      broughtApplicationForward: false,
    };
  }

  /** @returns {Window} The newly constructed browser window. */
  constructStandaloneWindow(request) {
    const args = Cc["@mozilla.org/supports-string;1"].createInstance(
      Ci.nsISupportsString,
    );
    args.data = request.uriString;

    const standaloneWindow = lazy.BrowserWindowTracker.openWindow({
      private: request.isPrivate,
      features: this.getStandaloneWindowFeatures(request),
      all: true,
      openerWindow: request.openerWindow,
      args,
      zenSyncedWindow: false,
      zenStandaloneWindow: true,
    });

    standaloneWindow._zenStartupSyncFlag = "unsynced";
    standaloneWindow.ZenExternalLinkStandaloneType = ZEN_STANDALONE_WINDOW_TYPE;
    if (request.userContextId) {
      standaloneWindow._zenStartupUnsyncedUserContextId = request.userContextId;
    }
    return standaloneWindow;
  }

  /** Attaches the standalone identity and state to a browser window. */
  markWindowAsStandalone(standaloneWindow, request) {
    let resolveReady;
    standaloneWindow.ZenExternalLinkStandaloneReady = false;
    standaloneWindow.ZenExternalLinkStandaloneReadyPromise = new Promise(
      (resolve) => {
        resolveReady = resolve;
      },
    );
    standaloneWindow.ZenExternalLinkStandaloneType = ZEN_STANDALONE_WINDOW_TYPE;
    standaloneWindow._zenStandaloneWindow = true;

    const state = {
      requestId: request.requestId,
      deliverySource: request.deliverySource,
      source: request.source,
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

    standaloneWindow.addEventListener(
      "unload",
      () => {
        this.#standaloneWindows.delete(standaloneWindow);
        this.#resolveStandaloneWindowReady(standaloneWindow);
      },
      { once: true },
    );
    return state;
  }

  /** Opens one external URL in a standalone window. */
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

  /** Opens a batch only after every URL has been validated. */
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
      }),
    );
    if (requests.some((request) => !request)) {
      return false;
    }

    const createdWindows = [];
    for (const request of requests) {
      const standaloneWindow = this.openExternalLinkStandaloneWindow({
        uriString: request.uriString,
        options: {
          ...options,
          requestId: request.requestId,
          deliverySource: request.deliverySource,
        },
        openerWindow: request.openerWindow,
      });
      if (!standaloneWindow) {
        for (const createdWindow of createdWindows) {
          const state = createdWindow.ZenExternalLinkStandalone;
          state.isKeeping = true;
          state.isClosing = true;
          createdWindow.skipNextCanClose = true;
          createdWindow.close();
        }
        return false;
      }
      createdWindows.push(standaloneWindow);
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
      "true",
    );
  }

  isStandaloneWindow(standaloneWindow) {
    return (
      !!standaloneWindow?.ZenExternalLinkStandalone &&
      standaloneWindow.ZenExternalLinkStandaloneType ===
        ZEN_STANDALONE_WINDOW_TYPE
    );
  }

  getStandaloneWindowBounds(_request = {}) {
    const defaultWidth = Services.prefs.getIntPref(
      "zen.standalone-window.default-width",
      1280,
    );
    const defaultHeight = Services.prefs.getIntPref(
      "zen.standalone-window.default-height",
      820,
    );
    const storedWidth = Services.prefs.getIntPref(
      "zen.standalone-window.last-width",
      0,
    );
    const storedHeight = Services.prefs.getIntPref(
      "zen.standalone-window.last-height",
      0,
    );

    return {
      width: storedWidth > 0 ? storedWidth : defaultWidth,
      height: storedHeight > 0 ? storedHeight : defaultHeight,
      left: Services.prefs.getIntPref("zen.standalone-window.last-screen-x", 0),
      top: Services.prefs.getIntPref("zen.standalone-window.last-screen-y", 0),
    };
  }

  getStandaloneWindowFeatures(request) {
    const { width, height, left, top } =
      this.getStandaloneWindowBounds(request);
    return `width=${width},height=${height},left=${left},top=${top}`;
  }

  shouldSuppressEmptyStartupWindow() {
    return false;
  }

  deferStartupWindowForExternalLink() {
    return false;
  }

  #isEnabled() {
    return Services.prefs.getBoolPref("zen.standalone-window.enabled", false);
  }

  #openRequest(request) {
    const standaloneWindow = this.constructStandaloneWindow(request);
    this.markWindowAsStandalone(standaloneWindow, request);

    this.#initializeStandaloneWindow(standaloneWindow).catch((error) => {
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

    this.markStandaloneDocument(standaloneWindow);
    this.#resolveStandaloneWindowReady(standaloneWindow);
  }

  #promiseDelayedStartup(standaloneWindow) {
    if (standaloneWindow.gBrowserInit?.delayedStartupFinished) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const observe = (subject, topic) => {
        if (subject != standaloneWindow) {
          return;
        }
        Services.obs.removeObserver(
          observe,
          "browser-delayed-startup-finished",
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
    state.resolveReady?.(standaloneWindow);
    delete state.resolveReady;
    if (!standaloneWindow.closed) {
      standaloneWindow.dispatchEvent(
        new standaloneWindow.CustomEvent("zen-standalone-window-ready"),
      );
    }
  }
}

export const gZenStandaloneWindowManager = new nsZenStandaloneWindowManager();

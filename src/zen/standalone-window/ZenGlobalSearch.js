// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const { gZenGlobalSearch } = ChromeUtils.importESModule(
  "resource:///modules/zen/standalonewindow/ZenGlobalSearch.sys.mjs"
);
const { gZenStandaloneWindowManager } = ChromeUtils.importESModule(
  "resource:///modules/zen/standalonewindow/ZenStandaloneWindowManager.sys.mjs"
);

// The stock URL bar reads the current browser for its principal, search mode
// and container. The panel supplies a blank context outside the tab manager.
var gURLBar;
var gBrowser = {
  get selectedBrowser() { return document.getElementById("search-context"); },
  get currentURI() { return this.selectedBrowser.currentURI; },
  get contentTitle() { return ""; },
  get browsers() { return [this.selectedBrowser]; },
  get tabs() { return [this.selectedTab]; },
  get selectedTabs() { return this.tabs; },
  selectedTab: {
    isEmpty: true,
    group: null,
    get linkedBrowser() { return gBrowser.selectedBrowser; },
    hasAttribute() { return false; },
    getAttribute() { return ""; },
  },
  getTabForBrowser(browser) {
    return browser === this.selectedBrowser ? this.selectedTab : null;
  },
  tabContainer: new EventTarget(),
  userTypedValue: "",
  addTabsProgressListener() {},
  removeTabsProgressListener() {},
};
var delayedStartupPromise = Promise.resolve();
var gKeywordURIFixup = { check() {} };
var gBrowserInit = { delayedStartupFinished: true, isAdoptingTab: () => false };
var gInitialPages = ["about:home", "about:blank", "about:newtab"];
var gZenUIManager = {
  onUrlbarOpen() {},
  onFloatingURLBarOpen() {},
  onUrlbarClose() {},
  enableCommandsMode() {},
};
var gZenVerticalTabsManager = {
  _hasSetSingleToolbar: false,
  recalculateURLBarHeight() {},
};
function isInitialPage(uri) { return gInitialPages.includes(uri?.spec ?? uri); }
function isBlankPageURL(spec) { return spec === "about:blank"; }
function UpdatePopupNotificationsVisibility() {}
function readFromClipboard() {
  const transfer = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
  transfer.init(window.docShell.QueryInterface(Ci.nsILoadContext));
  transfer.addDataFlavor("text/plain");
  try {
    Services.clipboard.getData(transfer, Ci.nsIClipboard.kGlobalClipboard);
    const data = {};
    transfer.getTransferData("text/plain", data);
    return data.value.QueryInterface(Ci.nsISupportsString).data;
  } catch {
    return "";
  }
}
function goDoCommand(command) {
  const controller = document.commandDispatcher.getControllerForCommand(command);
  if (controller?.isCommandEnabled(command)) {
    controller.doCommand(command);
  }
}
function promiseDocumentFlushed(callback) {
  return Promise.resolve().then(callback);
}

function submit(url, event, where, params = {}) {
  if (gZenGlobalSearch.panel !== window) {
    return;
  }
  const result = gZenStandaloneWindowManager.openGlobalSearchResultInStandalone({
    uriString: url,
    triggeringPrincipal: params.triggeringPrincipal,
    referrerInfo: params.referrerInfo,
    policyContainer: params.policyContainer,
    userContextId: params.userContextId,
    isPrivate: params.private === true,
    postData: params.postData,
    sourceEvent: event,
  });
  if (result) {
    gZenGlobalSearch.close(window);
  } else {
    gURLBar.focus();
    gURLBar.search(gURLBar.value);
  }
}

function openPreferences() { submit("about:preferences"); }
function openTrustedLinkIn(url, where, params) { submit(url, null, where, params); }
function switchToTabHavingURI(uri) {
  submit(uri.spec ?? uri);
  return true;
}

async function startSearch() {
  ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarInput.mjs", {
    global: "current",
  });
  await customElements.whenDefined("moz-urlbar");
  if (window.closed || gZenGlobalSearch.panel !== window) {
    return;
  }

  const { LightweightThemeConsumer } = ChromeUtils.importESModule(
    "resource://gre/modules/LightweightThemeConsumer.sys.mjs"
  );
  LightweightThemeConsumer.init(window);
  const { accent, scheme } = gZenGlobalSearch.theme;
  const style = document.documentElement.style;
  style.setProperty("--zen-primary-color", accent ||
    Services.prefs.getStringPref("zen.theme.accent-color", "AccentColor"));
  if (scheme) {
    style.colorScheme = scheme;
  }

  const template = document.getElementById("search-field");
  gURLBar = document.importNode(template.content.firstElementChild, true);
  document.getElementById("urlbar-container").appendChild(gURLBar);
  Object.defineProperty(gURLBar, "zenUrlbarBehavior", { value: "float" });
  const forceNavigation = () => {
    gURLBar.setAttribute("action-override", "true");
    gURLBar.view.panel.setAttribute("action-override", "true");
  };
  forceNavigation();
  window.addEventListener("keyup", forceNavigation);
  gURLBar._zenHandleUrlbarClose = () => {};
  gURLBar._loadURL = submit;

  const pickResult = gURLBar.pickResult.bind(gURLBar);
  gURLBar.pickResult = (...args) => {
    // Modifier keyup can clear this flag between opening and selecting a row.
    gURLBar.setAttribute("action-override", "true");
    return pickResult(...args);
  };
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      event.stopImmediatePropagation();
      gZenGlobalSearch.close(window);
    }
  }, true);
  window.addEventListener("mousedown", event => {
    if (!event.composedPath().includes(gURLBar)) {
      gZenGlobalSearch.close(window);
    }
  });
  window.addEventListener("unload", () => {
    if (gZenGlobalSearch.panel === window) {
      gZenGlobalSearch.panel = null;
    }
  }, { once: true });

  Services.zen.showSearchPanel(window.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow));
  gURLBar.search("");
  gURLBar.focus();
  gURLBar.select();
}
window.addEventListener("DOMContentLoaded", () => startSearch().catch(error => {
  console.error(error);
  gZenGlobalSearch.close(window);
}), { once: true });

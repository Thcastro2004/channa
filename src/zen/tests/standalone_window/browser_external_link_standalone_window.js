/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

/* eslint-disable mozilla/valid-services -- Services.zen is Zen's custom XPCOM service. */

const { gZenStandaloneWindowManager: manager, nsZenStandaloneWindowManager } =
  ChromeUtils.importESModule(
    "resource:///modules/zen/standalonewindow/ZenStandaloneWindowManager.sys.mjs"
  );

const BASE = "https://example.com/?standalone-phase3=";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.require_user_interaction_for_beforeunload", false],
      ["zen.glance.enabled", true],
      ["zen.view.drag-window-from-content", true],
    ],
  });
  await gZenWorkspaces.promiseInitialized;
  registerCleanupFunction(async () => {
    for (const win of Services.wm.getEnumerator(null)) {
      if (win._zenStandaloneWindow && !win.closed) {
        await closeStandalone(win);
      }
    }
  });
});

async function openStandalone(name, owner = manager, openerWindow = window) {
  const url = BASE + name;
  const win = owner.openExternalLinkStandaloneWindow({
    uriString: url,
    openerWindow,
    options: {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    },
  });
  Assert.ok(win, "Standalone construction succeeds");
  await win.ZenExternalLinkStandaloneReadyPromise;
  await TestUtils.waitForCondition(
    () => win.gBrowser?.selectedBrowser?.currentURI?.spec === url,
    "The standalone page is loaded",
    100,
    100
  );
  return win;
}

async function closeStandalone(win) {
  if (!win || win.closed) {
    return;
  }
  const closed = BrowserTestUtils.domWindowClosed(win);
  win.skipNextCanClose = true;
  win.close();
  await closed;
}

function isEffectivelyHidden(element) {
  if (!element) {
    return true;
  }
  const ownerWindow = element.ownerGlobal ?? element.ownerDocument?.defaultView;
  if (!ownerWindow) {
    return true;
  }
  const { display, visibility } = ownerWindow.getComputedStyle(element);
  return display === "none" || visibility === "hidden";
}

add_task(async function external_routing_and_workspace_exclusion() {
  const spaces = gZenWorkspaces.getWorkspaces().map(space => space.uuid);
  const count = gBrowser.tabs.length;
  const url = BASE + "external";
  Assert.equal(
    gBrowser.addTab(url, {
      fromExternal: true,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    }),
    null,
    "External addTab is intercepted"
  );
  let win;
  try {
    await TestUtils.waitForCondition(
      () => (win = manager.getStandaloneWindowForURL(url)),
      "The routed window is discoverable",
      100,
      100
    );
    await win.ZenExternalLinkStandaloneReadyPromise;
    await win.gZenWorkspaces.promiseInitialized;
    await win.gZenWorkspaces.promisePinnedInitialized;
    Assert.equal(win.gBrowser.tabs.length, 1, "One page only");
    if (!SpecialPowers.isHeadless) {
      const panel = win.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow);
      const normal = window.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow);
      Assert.ok(
        Services.zen.isStandalonePanel(panel),
        "Native standalone panel"
      );
      Assert.ok(
        !Services.zen.isStandalonePanel(normal),
        "Normal browser window"
      );
      const dock = Cc["@mozilla.org/widget/macdocksupport;1"].getService(
        Ci.nsIMacDockSupport
      );
      Assert.greater(
        dock.getWindowNumber(normal),
        0,
        "Keep target has a native window ID"
      );
    }
    Assert.ok(
      !win.gZenWorkspaces.shouldHaveWorkspaces,
      "No workspace lifecycle"
    );
    Assert.ok(!win.gZenWorkspaces.workspaceEnabled, "Workspaces stay disabled");
    Assert.equal(
      win.gZenWorkspaces.getWorkspaces().length,
      0,
      "No synthetic space"
    );
    Assert.ok(
      !win.gBrowser.selectedTab.hasAttribute("zen-workspace-id"),
      "No space identity"
    );
    Assert.ok(!win.document.querySelector("[zen-empty-tab]"), "No empty tab");
    Assert.ok(
      !win.document.documentElement.hasAttribute("persist"),
      "Normal geometry is isolated"
    );
    Assert.equal(gBrowser.tabs.length, count, "Opener gains no tab");
    Assert.deepEqual(
      gZenWorkspaces.getWorkspaces().map(space => space.uuid),
      spaces,
      "Opener spaces are unchanged"
    );
    Assert.ok(win.ZenExternalLinkStandalone.toolbar, "Keep toolbar exists");
    Assert.ok(
      !win.document.getElementById("zen-standalone-window-close-button"),
      "Native titlebar owns close"
    );
    for (const id of [
      "cmd_newNavigator",
      "cmd_newNavigatorTab",
      "Browser:DuplicateTab",
      "History:UndoCloseTab",
      "Tools:ClassicWindow",
      "cmd_zenToggleSidebar",
    ]) {
      const command = win.document.getElementById(id);
      if (command) {
        Assert.equal(
          command.getAttribute("disabled"),
          "true",
          `${id} is disabled`
        );
      }
    }
  } finally {
    await closeStandalone(win);
  }
});

add_task(async function standalone_chrome_is_minimal() {
  const win = await openStandalone("minimal-chrome");
  try {
    const { document } = win;
    for (const id of [
      "forward-button",
      "stop-reload-button",
      "unified-extensions-button",
      "fxa-toolbar-menu-button",
      "nav-bar-overflow-button",
      "PanelUI-button",
    ]) {
      Assert.ok(
        isEffectivelyHidden(document.getElementById(id)),
        `${id} is hidden`
      );
    }
    Assert.ok(
      !isEffectivelyHidden(document.getElementById("urlbar-container")),
      "Address bar remains visible"
    );
    const actors = await SpecialPowers.spawn(
      win.gBrowser.selectedBrowser,
      [],
      () =>
        ["ZenGlance", "ZenWindowDrag"].map(
          name => !!content.windowGlobalChild.getActor(name)
        )
    );
    Assert.deepEqual(actors, [true, true], "Standalone content actors load");
    Assert.ok(
      !isEffectivelyHidden(
        document.getElementById("zen-standalone-window-keep")
      ),
      "Keep control remains visible"
    );
    const backButton = document.getElementById("back-button");
    const backCommand = document.getElementById("Browser:Back");
    Assert.equal(
      isEffectivelyHidden(backButton),
      backCommand.hasAttribute("disabled"),
      "Back is visible exactly when history is available"
    );
    Assert.equal(
      win.getComputedStyle(document.getElementById("zen-tabbox-wrapper"))
        .marginInlineStart,
      "0px",
      "Page sits flush against the window"
    );
  } finally {
    await closeStandalone(win);
  }
});

add_task(async function geometry_is_separate_and_only_normal_changes_persist() {
  const prefs = ["last-width", "last-height", "last-screen-x", "last-screen-y"];
  await SpecialPowers.pushPrefEnv({
    set: prefs.map(name => [`zen.standalone-window.${name}`, 0]),
  });
  try {
    const bounds = {
      width: Math.min(700, screen.availWidth - 80),
      height: Math.min(500, screen.availHeight - 80),
      left: screen.availLeft + 40,
      top: screen.availTop + 40,
    };
    const win = {
      closed: false,
      windowState: 0,
      STATE_NORMAL: 0,
      outerWidth: bounds.width,
      outerHeight: bounds.height,
      screenX: bounds.left,
      screenY: bounds.top,
      ZenExternalLinkStandalone: { initialNormalBounds: bounds },
    };
    Assert.ok(
      !manager.persistStandaloneWindowGeometry(win),
      "Opening alone does not save geometry"
    );
    win.ZenExternalLinkStandalone.initialNormalBounds = null;
    Assert.ok(
      manager.persistStandaloneWindowGeometry(win),
      "Changed normal geometry is saved"
    );
    const restored = Object.fromEntries(
      manager
        .getStandaloneWindowFeatures({ openerWindow: window })
        .split(",")
        .map(part => {
          const [key, value] = part.split("=");
          return [key, Number(value)];
        })
    );
    Assert.deepEqual(
      restored,
      bounds,
      "Geometry round trips through dedicated prefs"
    );
    win.windowState = 1;
    win.outerWidth = 2000;
    Assert.ok(
      !manager.persistStandaloneWindowGeometry(win),
      "Maximized bounds are ignored"
    );
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function simultaneous_windows_cascade() {
  let first, second;
  try {
    first = await openStandalone("cascade-first");
    second = await openStandalone("cascade-second");
    Assert.notStrictEqual(first, second, "Separate native windows");
    Assert.ok(
      manager.hasOtherStandaloneWindows(first),
      "Second standalone prevents focus return"
    );
    Assert.ok(
      first.screenX !== second.screenX || first.screenY !== second.screenY,
      "Windows cascade"
    );
  } finally {
    await closeStandalone(second);
    await closeStandalone(first);
  }
});

for (const command of [
  "cmd_close",
  "cmd_closeWindow",
  "remove-tab",
  "manager",
  "keyboard",
  "native",
]) {
  add_task(async function close_entry_points_archive_once() {
    const url = BASE + command;
    const count = SessionStore.getClosedWindowCount();
    const before = SessionStore.getClosedTabDataForWindow(window).filter(tab =>
      tab.state.entries.some(entry => entry.url === url)
    ).length;
    const win = await openStandalone(command);
    const state = win.ZenExternalLinkStandalone;
    let replacement = false;
    win.addEventListener("TabOpen", () => {
      replacement = true;
    });
    try {
      const closed = BrowserTestUtils.domWindowClosed(win);
      if (command === "remove-tab") {
        win.gBrowser.removeTab(win.gBrowser.selectedTab, {
          animate: false,
          closeWindowWithLastTab: false,
        });
      } else if (command === "manager") {
        Assert.ok(manager.closeStandaloneWindow(win), "Manager accepts close");
      } else if (command === "keyboard") {
        win.dispatchEvent(
          new win.KeyboardEvent("keydown", {
            key: "w",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          })
        );
      } else if (command === "native") {
        win.close();
      } else {
        Assert.ok(state.commandListener, "Close command is captured");
        win.document.getElementById(command).doCommand();
      }
      await closed;
      await TestUtils.waitForCondition(
        () => state.commandListener === null,
        "Unload removed listeners"
      );
      Assert.ok(!replacement, "No replacement tab was created");
      Assert.ok(state.closedTabRecorded, "Page was archived");
      Assert.equal(
        SessionStore.getClosedWindowCount(),
        count,
        "No closed window record"
      );
      const records = SessionStore.getClosedTabDataForWindow(window).filter(
        tab => tab.state.entries.some(entry => entry.url === url)
      );
      Assert.equal(records.length, before + 1, "Exactly one closed tab record");
      Assert.ok(
        !records.at(-1).state.zenWorkspace,
        "Recovery carries no workspace identity"
      );
    } finally {
      await closeStandalone(win);
    }
  });
}

add_task(async function session_exclusion_and_undo_close() {
  const win = await openStandalone("undo");
  let tab;
  try {
    const data = SessionStore.getWindowState(win).windows[0];
    Assert.ok(
      data.isZenStandalone && data.isZenUnsynced,
      "SessionStore marks the transient window"
    );
    Assert.ok(
      !JSON.parse(SessionStore.getBrowserState()).windows.some(
        item => item.isZenStandalone
      ),
      "Saved state excludes it"
    );
    const closed = BrowserTestUtils.domWindowClosed(win);
    manager.closeStandaloneWindow(win);
    await closed;
    const opened = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "TabOpen"
    );
    SessionWindowUI.undoCloseTab(window, 0);
    tab = (await opened).target;
    await TestUtils.waitForCondition(
      () => tab.linkedBrowser.currentURI?.spec === BASE + "undo",
      "Undo restores the page"
    );
    Assert.equal(tab.ownerDocument, document, "Recovery uses the normal window");
    Assert.equal(
      tab.getAttribute("zen-workspace-id"),
      gZenWorkspaces.activeWorkspace,
      "Recovery uses the current space"
    );
  } finally {
    await closeStandalone(win);
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(async function workspace_shortcuts_are_swallowed() {
  const win = await openStandalone("shortcuts");
  try {
    for (const [key, shiftKey] of [
      ["t", false],
      ["b", false],
      ["p", true],
    ]) {
      const event = new win.KeyboardEvent("keydown", {
        key,
        shiftKey,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      win.dispatchEvent(event);
      Assert.ok(event.defaultPrevented, `Command ${key} is swallowed`);
    }
    const event = new win.KeyboardEvent("keydown", {
      key: "t",
      metaKey: true,
      altKey: true,
      cancelable: true,
    });
    win.dispatchEvent(event);
    Assert.ok(!event.defaultPrevented, "Option shortcuts are excluded");
    Assert.equal(win.gBrowser.tabs.length, 1, "No hidden tab was created");
  } finally {
    await closeStandalone(win);
  }
});

add_task(async function cancelled_beforeunload_runs_once() {
  if (Services.env.get("MOZ_HEADLESS")) {
    Assert.ok(true, "Native beforeunload prompt requires the headful run");
    return;
  }
  const win = await openStandalone("beforeunload");
  const browser = win.gBrowser.selectedBrowser;
  try {
    await SpecialPowers.spawn(browser, [], () => {
      content.beforeUnloadCount = 0;
      content.onbeforeunload = event => {
        content.beforeUnloadCount++;
        event.preventDefault();
        event.returnValue = "";
      };
    });
    const dialog = BrowserTestUtils.promiseAlertDialogOpen("cancel");
    win.document.getElementById("cmd_close").doCommand();
    await dialog;
    Assert.ok(
      !win.closed && !win.ZenExternalLinkStandalone.isClosing,
      "Cancellation leaves a usable window"
    );
    Assert.equal(
      await SpecialPowers.spawn(browser, [], () => content.beforeUnloadCount),
      1,
      "One unload prompt per attempt"
    );
  } finally {
    await SpecialPowers.spawn(browser, [], () => {
      content.onbeforeunload = null;
    });
    await closeStandalone(win);
  }
});

add_task(async function failed_keep_reenables_controls() {
  const win = await openStandalone("failed-keep");
  const adopt = manager.adoptStandaloneTab;
  const reopen = manager.reopenStandaloneUrlInSpace;
  try {
    manager.adoptStandaloneTab = () => null;
    manager.reopenStandaloneUrlInSpace = () => null;
    EventUtils.synthesizeMouseAtCenter(
      win.ZenExternalLinkStandalone.toolbar.openInSpaceButton,
      {},
      win
    );
    Assert.ok(
      !win.closed && !win.ZenExternalLinkStandalone.isKeeping,
      "Failed keep leaves page usable"
    );
    for (const button of win.ZenExternalLinkStandalone.toolbar.root.querySelectorAll(
      '[role="button"]'
    )) {
      Assert.ok(!button.hasAttribute("disabled"), "Control reenabled");
    }
  } finally {
    manager.adoptStandaloneTab = adopt;
    manager.reopenStandaloneUrlInSpace = reopen;
    await closeStandalone(win);
  }
});

add_task(async function keep_preserves_live_history_and_page_state() {
  const win = await openStandalone("keep-first");
  let tab;
  try {
    const button = win.ZenExternalLinkStandalone.toolbar.openInSpaceButton;
    await win.document.l10n.translateFragment(button);
    Assert.equal(
      button
        .querySelector(".zen-standalone-window-keep-prefix")
        .getAttribute("value"),
      "Open in",
      "Prefix is localized"
    );
    Assert.equal(
      button
        .querySelector(".zen-standalone-window-keep-space")
        .getAttribute("value"),
      gZenWorkspaces.getActiveWorkspaceFromCache().name,
      "Keep names the captured space"
    );
    const browser = win.gBrowser.selectedBrowser;
    const loaded = BrowserTestUtils.browserLoaded(
      browser,
      false,
      BASE + "keep-second"
    );
    BrowserTestUtils.startLoadingURIString(browser, BASE + "keep-second");
    await loaded;
    await SpecialPowers.spawn(browser, [], () => {
      content.standaloneSentinel = "preserved";
    });
    const opened = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "TabOpen"
    );
    const closed = BrowserTestUtils.domWindowClosed(win);
    win.dispatchEvent(
      new win.KeyboardEvent("keydown", {
        key: "o",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
    tab = (await opened).target;
    await closed;
    await TestUtils.waitForCondition(
      () => gBrowser.selectedTab === tab,
      "Kept tab is selected"
    );
    Assert.equal(
      tab.linkedBrowser.currentURI.spec,
      BASE + "keep-second",
      "Current URL survives"
    );
    Assert.ok(tab.linkedBrowser.canGoBack, "Session history survives adoption");
    Assert.equal(
      await SpecialPowers.spawn(
        tab.linkedBrowser,
        [],
        () => content.standaloneSentinel
      ),
      "preserved",
      "Live page was not reloaded"
    );
  } finally {
    await closeStandalone(win);
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(async function picker_filters_and_keeps_in_selected_space() {
  const original = gZenWorkspaces.getActiveWorkspace();
  const destination = await gZenWorkspaces.createAndSaveWorkspace(
    "Standalone Destination"
  );
  await gZenWorkspaces.changeWorkspace(original);
  let win, tab;
  try {
    win = await openStandalone("picker");
    await SimpleTest.promiseFocus(win);
    const document = win.document;
    const panel = document.getElementById(
      "PanelUI-zen-standalone-window-spaces"
    );
    const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
    EventUtils.synthesizeMouseAtCenter(
      win.ZenExternalLinkStandalone.toolbar.spacePickerButton, {}, win
    );
    await shown;
    const list = document.getElementById(
      "PanelUI-zen-standalone-window-spaces-list"
    );
    const search = document.getElementById(
      "PanelUI-zen-standalone-window-spaces-search"
    );
    const empty = document.getElementById(
      "PanelUI-zen-standalone-window-spaces-empty"
    );
    const active = list.querySelector('[active="true"]');
    Assert.ok(
      active.querySelector(".zen-standalone-window-space-icon"),
      "Row has an icon tile"
    );
    Assert.ok(
      !active.querySelector(":scope > .toolbarbutton-text"),
      "Row owns its label"
    );
    search.value = "no such space exists";
    search.dispatchEvent(new win.Event("input"));
    Assert.ok(!empty.hidden, "No matches shows the empty state");
    document
      .getElementById("PanelUI-zen-standalone-window-spaces-collapse")
      .doCommand();
    await TestUtils.waitForCondition(
      () => panel.state === "closed",
      "Collapse closes picker"
    );
    Assert.ok(
      manager.openStandaloneSpacePicker(win),
      "Picker can reopen without duplicate handlers"
    );
    search.value = "standalone destination";
    search.dispatchEvent(new win.Event("input"));
    const row = list.querySelector(`[zen-workspace-id="${destination.uuid}"]`);
    Assert.ok(
      !row.hidden && [...list.children].some(item => item.hidden),
      "Search filters spaces"
    );
    const opened = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "TabOpen"
    );
    const closed = BrowserTestUtils.domWindowClosed(win);
    row.doCommand();
    tab = (await opened).target;
    await closed;
    await TestUtils.waitForCondition(
      () => tab.getAttribute("zen-workspace-id") === destination.uuid,
      "Kept page reaches the chosen space"
    );
  } finally {
    await closeStandalone(win);
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await gZenWorkspaces.changeWorkspace(original);
    await gZenWorkspaces.removeWorkspace(destination.uuid);
  }
});

add_task(async function cold_link_cancels_classic_startup() {
  const owner = new nsZenStandaloneWindowManager();
  let opened = false;
  Assert.ok(
    owner.deferStartupWindowForExternalLink(() => {
      opened = true;
    }),
    "Startup can be held once"
  );
  let win;
  try {
    Assert.ok(owner.isHoldingStartupWindow, "Survival area owns startup");
    Assert.ok(
      owner.openExternalLinksInStandaloneWindows([BASE + "cold"], window),
      "Cold link claims the launch"
    );
    win = owner.getStandaloneWindowForURL(BASE + "cold");
    await win.ZenExternalLinkStandaloneReadyPromise;
    Assert.ok(
      !owner.isHoldingStartupWindow && !opened,
      "Classic startup callback never ran"
    );
    Assert.ok(
      owner.shouldSuppressEmptyStartupWindow(),
      "Companion empty command line is suppressed"
    );
    Assert.ok(
      !owner.deferStartupWindowForExternalLink(() => {}),
      "No second startup deferral"
    );
  } finally {
    await closeStandalone(win);
  }
});

add_task(async function invalid_batch_and_partial_failure_are_atomic() {
  const owner = new nsZenStandaloneWindowManager();
  let calls = 0;
  const open = owner.openExternalLinkStandaloneWindow;
  owner.openExternalLinkStandaloneWindow = () => {
    calls++;
    return null;
  };
  Assert.ok(
    !owner.openExternalLinksInStandaloneWindows([BASE + "valid", ""], window),
    "Invalid batch rejected"
  );
  Assert.equal(calls, 0, "Nothing is constructed before full validation");
  owner.openExternalLinkStandaloneWindow = open;
  const win = await openStandalone("rollback", owner);
  const state = win.ZenExternalLinkStandalone;
  try {
    owner.openExternalLinkStandaloneWindow = () => (++calls === 1 ? win : null);
    const closed = BrowserTestUtils.domWindowClosed(win);
    Assert.ok(
      !owner.openExternalLinksInStandaloneWindows(
        [BASE + "one", BASE + "two"],
        window
      ),
      "Partial construction rolls back"
    );
    await closed;
    Assert.ok(
      state.isKeeping && !state.closedTabRecorded,
      "Rollback does not archive duplicate pages"
    );
  } finally {
    owner.openExternalLinkStandaloneWindow = open;
    await closeStandalone(win);
  }
});

add_task(async function fallback_preserves_current_url_and_security_context() {
  const principal = Services.scriptSecurityManager.createNullPrincipal({});
  const source = {
    gBrowser: { selectedBrowser: { currentURI: { spec: BASE + "navigated" } } },
    ZenExternalLinkStandalone: {
      uriString: BASE + "original",
      triggeringPrincipal: principal,
      referrerInfo: {},
      policyContainer: {},
      userContextId: 3,
    },
  };
  let result;
  const target = {
    gBrowser: {
      addTab(url, options) {
        result = { url, options };
        return result;
      },
    },
  };
  Assert.ok(
    manager.reopenStandaloneUrlInSpace(source, target, {
      uuid: "chosen",
      containerTabId: 8,
    }),
    "Fallback creates a tab"
  );
  Assert.equal(
    result.url,
    BASE + "navigated",
    "Fallback uses the current page"
  );
  Assert.equal(
    result.options.triggeringPrincipal,
    principal,
    "Principal is preserved"
  );
  Assert.equal(
    result.options.referrerInfo,
    source.ZenExternalLinkStandalone.referrerInfo,
    "Referrer is preserved"
  );
  Assert.equal(
    result.options.policyContainer,
    source.ZenExternalLinkStandalone.policyContainer,
    "Policy is preserved"
  );
  Assert.ok(result.options.skipRoute, "Fallback cannot recurse into routing");
  Assert.equal(result.options.userContextId, 8, "Destination container wins");
  Assert.equal(
    result.options.zenWorkspaceId,
    "chosen",
    "Destination space is explicit"
  );
});

add_task(async function archive_api_reports_unavailable_inputs() {
  Assert.equal(
    SessionStore.recordClosedTabForOtherWindow(null, null).reason,
    "undo-disabled-or-target-missing",
    "Missing target has a diagnostic reason"
  );
  Assert.equal(
    SessionStore.recordClosedTabForOtherWindow(window, null).reason,
    "source-browser-detached",
    "Detached browser has a diagnostic reason"
  );
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sessionstore.max_tabs_undo", 0]],
  });
  try {
    Assert.equal(
      SessionStore.recordClosedTabForOtherWindow(window, gBrowser.selectedTab)
        .reason,
      "undo-disabled-or-target-missing",
      "Undo preference is respected"
    );
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function private_standalone_keeps_its_privacy_boundary() {
  const privateWindow = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  let win;
  try {
    await privateWindow.gZenWorkspaces.promiseInitialized;
    win = await openStandalone("private", manager, privateWindow);
    Assert.equal(
      manager.getStandaloneKeepTargetWindow(win),
      privateWindow,
      "Private destination is retained"
    );
    Assert.equal(
      manager.getStandaloneArchiveTargetWindow(win),
      privateWindow,
      "Archive lookup cannot select a public window"
    );
    const data = SessionStore.recordClosedTabForOtherWindow(
      window,
      win.gBrowser.selectedTab
    );
    Assert.equal(
      data.reason,
      "privacy-mismatch",
      "Public recovery rejects a private page"
    );
  } finally {
    await closeStandalone(win);
    await BrowserTestUtils.closeWindow(privateWindow);
  }
});

add_task(async function promotion_waits_for_a_new_normal_window() {
  const owner = new nsZenStandaloneWindowManager();
  const win = await openStandalone("new-normal", owner);
  let target;
  owner.getStandaloneKeepTargetWindow = () => target ?? null;
  try {
    const opened = BrowserTestUtils.domWindowOpened();
    const closed = BrowserTestUtils.domWindowClosed(win);
    Assert.ok(
      owner.keepStandaloneWindowInNewWindow(win),
      "Normal startup begins"
    );
    Assert.ok(
      win.ZenExternalLinkStandalone.isKeeping,
      "Page is protected while destination starts"
    );
    target = await opened;
    await closed;
    await TestUtils.waitForCondition(
      () =>
        target.gBrowser?.selectedBrowser?.currentURI?.spec ===
        BASE + "new-normal",
      "The newly initialized normal window receives the page",
      100,
      100
    );
    Assert.ok(
      target.gZenWorkspaces.workspaceEnabled,
      "Destination has normal workspaces"
    );
    Assert.ok(!target._zenStandaloneWindow, "Destination is a normal window");
    BrowserTestUtils.removeTab(target.gBrowser.selectedTab);
  } finally {
    await closeStandalone(win);
    if (target && !target.closed) {
      await BrowserTestUtils.closeWindow(target);
    }
  }
});

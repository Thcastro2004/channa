# Phase 3 acceptance on macOS

Use a current native build, enable `zen.standalone-window.enabled`, and record
its build ID. Phase 4 owns appearance; these checks concern behavior.

1. Open an external link with a normal Zen window present. Confirm one standalone
   page, no workspace or empty tab, and no new tab in the normal window.
2. Close separate pages using Command-W, both Close menu commands, the red traffic
   light, and removal of the sole tab. Each closes the whole native window, creates
   one normal closed-tab entry, and leaves closed-window history unchanged.
3. Use a page with beforeunload. Cancel once: exactly one prompt, same usable page.
   Accept the next attempt: exactly one close and recovery entry.
4. Move and resize a standalone, then close and reopen one. Placement and size
   survive. Open several together: they cascade. Normal-window geometry is unchanged.
   Maximized, minimized, and fullscreen bounds must not replace the saved rectangle.
5. Navigate twice and enter text in a page. Use Command-O or the keep control.
   The live page, form state, and Back history move into the captured normal space.
6. Open the picker. Search matching and nonmatching names, clear the search,
   collapse, reopen, and select a different space. The kept tab reaches that space.
7. Keep a page from another application's fullscreen Space. The standalone closes
   first; macOS then follows the normal destination window and selects the kept tab.
8. Close an ordinary standalone and undo in the normal window. The page returns in
   the current workspace. Repeat undo to reach the previous normal closed tab.
9. Close a standalone after visiting a normal Zen window: Zen keeps focus. With two
   standalones, closing one must not return focus to the external application.
10. With only a private normal window open, deliver an external link and keep it.
    The page remains private; public closed-tab history never receives it.
11. Quit Zen with standalones open, then launch normally. Only normal sessions return.
12. Quit Zen, then open a link from another application, including fullscreen. Only
    the standalone appears on that Space, without activating Zen. Keeping it opens
    a normal window and restores the session that startup held back.
13. Launch normally from the Dock with no URL. The brief startup grace expires and
    normal startup runs once. Repeat with the grace preference set to zero.

Run the automated suite with `mach mochitest zen/tests/standalone_window`.
Native activation, Spaces, and fullscreen require the manual checks above even
when the automated suite passes.

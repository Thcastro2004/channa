# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

<!-- Sliding keeps the search row on the keep control in short windows.
     Nonnative prevents NSPopover from replacing our offsets with its own
     centered callout geometry when widget.macos.native-popovers is enabled. -->
<panel type="arrow" nonnative="true" orient="vertical"
       id="PanelUI-zen-standalone-window-spaces" flip="slide" side="bottom">
  <hbox id="PanelUI-zen-standalone-window-spaces-header" align="center">
    <image id="PanelUI-zen-standalone-window-spaces-search-icon"
           src="chrome://global/skin/icons/search-glass.svg"/>
    <html:input type="search" id="PanelUI-zen-standalone-window-spaces-search"
                data-l10n-id="zen-standalone-window-spaces-search" />
    <toolbarbutton id="PanelUI-zen-standalone-window-spaces-collapse"
                   data-l10n-id="zen-standalone-window-spaces-collapse" />
  </hbox>
  <vbox id="PanelUI-zen-standalone-window-spaces-list" />
  <hbox id="PanelUI-zen-standalone-window-spaces-empty" hidden="true" align="center">
    <label data-l10n-id="zen-standalone-window-spaces-empty" />
  </hbox>
</panel>

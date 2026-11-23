/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ZenCommonUtils.h"

#include "nsIBaseWindow.h"
#include "nsIWidget.h"
#include "nsThreadUtils.h"

#include <algorithm>
#include <cmath>
#include <cstdint>

#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#include "mozilla/Preferences.h"
#include "mozilla/Services.h"
#include "nsIObserverService.h"

enum class ZenPreparedPanelKind : uint8_t {
  None,
  Standalone,
  Search,
};

static ZenPreparedPanelKind sPreparedPanelKind = ZenPreparedPanelKind::None;

@class ChildView;

extern void ZenEnsureFrameViewClassIsSwizzled(Class aFrameViewClass);
extern void ZenWindowMouseEntered(NSEvent* aEvent);
extern void ZenWindowMouseExited(NSEvent* aEvent);
extern void ZenWindowMouseMoved(NSEvent* aEvent);
extern void ZenWindowDestroyed(NSWindow* aWindow);

@interface NSWindow (ZenPrivateFrameView)
+ (Class)frameViewClassForStyleMask:(NSUInteger)aStyleMask;
@end

@interface NSView (ZenPrivateTitlebar)
- (void)_tileTitlebarAndRedisplay:(BOOL)aRedisplay;
@end

@interface ZenStandalonePanel : NSPanel {
 @private
  NSTrackingArea* _zenTrackingArea;
  NSView* _zenViewWithTrackingArea;
  BOOL _zenDrawsIntoWindowFrame;
  BOOL _zenIsBeingShown;
  BOOL _zenAnimationSuppressed;
  NSRect _zenWindowButtonsRect;
  mozilla::WindowShadow _zenShadowStyle;
}
@end

@interface ZenSearchPanel : ZenStandalonePanel
@end

bool ZenWindowActsAsMain(NSWindow* aWindow) {
  return [aWindow isMemberOfClass:[ZenStandalonePanel class]];
}

@implementation ZenStandalonePanel

+ (Class)frameViewClassForStyleMask:(NSUInteger)aStyleMask {
  Class frameViewClass = [super frameViewClassForStyleMask:aStyleMask];
  ZenEnsureFrameViewClassIsSwizzled(frameViewClass);
  return frameViewClass;
}

- (instancetype)initWithContentRect:(NSRect)aContentRect
                          styleMask:(NSWindowStyleMask)aStyleMask
                            backing:(NSBackingStoreType)aBackingType
                              defer:(BOOL)aFlag {
  NSWindowStyleMask style =
      aStyleMask | NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
      NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable |
      NSWindowStyleMaskFullSizeContentView;
  if ([self isKindOfClass:[ZenSearchPanel class]]) {
    style = NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel;
  }
  self = [super initWithContentRect:aContentRect
                          styleMask:style
                            backing:aBackingType
                              defer:aFlag];
  if (self) {
    self.floatingPanel = [self isKindOfClass:[ZenSearchPanel class]];
    if (self.floatingPanel) {
      self.level = NSFloatingWindowLevel;
    }
    self.hidesOnDeactivate = NO;
    self.worksWhenModal = YES;
    self.becomesKeyOnlyIfNeeded = NO;
    self.releasedWhenClosed = YES;
    self.titleVisibility = NSWindowTitleVisible;
    self.titlebarAppearsTransparent = NO;
    _zenTrackingArea = nil;
    _zenViewWithTrackingArea = nil;
    _zenDrawsIntoWindowFrame = NO;
    _zenIsBeingShown = NO;
    _zenAnimationSuppressed = NO;
    _zenWindowButtonsRect = NSZeroRect;
    _zenShadowStyle = mozilla::WindowShadow::None;
  }
  return self;
}

- (BOOL)canBecomeKeyWindow {
  return YES;
}

- (BOOL)canBecomeMainWindow {
  return YES;
}

// Window managers should assign standalone pages to a workspace.
- (NSAccessibilitySubrole)accessibilitySubrole {
  return NSAccessibilityStandardWindowSubrole;
}

// A standalone is never a fullscreen-primary window. Gecko reapplies native
// fullscreen attributes after the initial Space behaviour, so enforce this on
// every collection-behaviour change rather than only during construction.
- (void)setCollectionBehavior:(NSWindowCollectionBehavior)aBehavior {
  aBehavior &= ~(NSWindowCollectionBehaviorFullScreenPrimary |
                 NSWindowCollectionBehaviorFullScreenAllowsTiling);
  aBehavior |= NSWindowCollectionBehaviorMoveToActiveSpace |
               NSWindowCollectionBehaviorFullScreenAuxiliary |
               NSWindowCollectionBehaviorFullScreenDisallowsTiling;
  if ([self isKindOfClass:[ZenSearchPanel class]]) {
    aBehavior &= ~(NSWindowCollectionBehaviorManaged | NSWindowCollectionBehaviorParticipatesInCycle);
    aBehavior |= NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorIgnoresCycle;
  } else {
    aBehavior |= NSWindowCollectionBehaviorParticipatesInCycle;
  }
  [super setCollectionBehavior:aBehavior];
}

- (void)makeKeyAndOrderFront:(id)aSender {
  [super makeKeyAndOrderFront:aSender];
  if (ZenWindowActsAsMain(self) && !NSApp.active && self.keyWindow) {
    [NSRunningApplication.currentApplication activateWithOptions:0];
  }
}

- (void)orderFrontRegardless {
  if (self.miniaturized) {
    [self deminiaturize:nil];
  }
  [super orderFrontRegardless];
}

- (void)setHidesOnDeactivate:(BOOL)aHides {
  [super setHidesOnDeactivate:NO];
}

- (NSRect)childViewRectForFrameRect:(NSRect)aFrameRect {
  if (_zenDrawsIntoWindowFrame) {
    return aFrameRect;
  }
  NSUInteger style = self.styleMask & ~NSWindowStyleMaskFullSizeContentView;
  return [NSWindow contentRectForFrameRect:aFrameRect styleMask:style];
}

- (NSRect)frameRectForChildViewRect:(NSRect)aChildViewRect {
  if (_zenDrawsIntoWindowFrame) {
    return aChildViewRect;
  }
  NSUInteger style = self.styleMask & ~NSWindowStyleMaskFullSizeContentView;
  return [NSWindow frameRectForContentRect:aChildViewRect styleMask:style];
}

- (NSRect)childViewFrameRectForCurrentBounds {
  NSRect frame = self.frame;
  NSRect rect = [self childViewRectForFrameRect:frame];
  rect.origin.x -= frame.origin.x;
  rect.origin.y -= frame.origin.y;
  return rect;
}

- (ChildView*)mainChildView {
  NSView* lastView = self.contentView.subviews.lastObject;
  return [lastView isKindOfClass:[ChildView class]] ? (ChildView*)lastView
                                                    : nil;
}

- (void)updateChildViewFrameRect {
  ((NSView*)self.mainChildView).frame = self.childViewFrameRectForCurrentBounds;
}

- (NSArray<NSView*>*)contentViewContents {
  return [[self.contentView.subviews copy] autorelease];
}

- (void)setDrawsContentsIntoWindowFrame:(BOOL)aState {
  if (_zenDrawsIntoWindowFrame == aState) {
    return;
  }
  _zenDrawsIntoWindowFrame = aState;
  self.titleVisibility = aState ? NSWindowTitleHidden : NSWindowTitleVisible;
  self.titlebarAppearsTransparent = aState;
  [self updateChildViewFrameRect];
}

- (BOOL)drawsContentsIntoWindowFrame {
  return _zenDrawsIntoWindowFrame;
}

- (void)setIsBeingShown:(BOOL)aState {
  _zenIsBeingShown = aState;
}

- (BOOL)isBeingShown {
  return _zenIsBeingShown;
}

- (BOOL)isVisibleOrBeingShown {
  return self.visible || _zenIsBeingShown;
}

- (void)setIsAnimationSuppressed:(BOOL)aState {
  _zenAnimationSuppressed = aState;
}

- (BOOL)isAnimationSuppressed {
  return _zenAnimationSuppressed;
}

- (NSTimeInterval)animationResizeTime:(NSRect)aNewFrame {
  return _zenAnimationSuppressed ? 0.0 : [super animationResizeTime:aNewFrame];
}

- (NSTouchBar*)makeTouchBar {
  return nil;
}

- (void)disableSetNeedsDisplay {
}

- (void)enableSetNeedsDisplay {
}

- (NSView*)trackingAreaView {
  NSView* contentView = self.contentView;
  return contentView.superview ? contentView.superview : contentView;
}

- (void)createTrackingArea {
  _zenViewWithTrackingArea = [self.trackingAreaView retain];
  const NSTrackingAreaOptions options =
      NSTrackingMouseEnteredAndExited | NSTrackingMouseMoved |
      NSTrackingActiveAlways | NSTrackingInVisibleRect;
  _zenTrackingArea =
      [[NSTrackingArea alloc] initWithRect:_zenViewWithTrackingArea.bounds
                                   options:options
                                     owner:self
                                  userInfo:nil];
  [_zenViewWithTrackingArea addTrackingArea:_zenTrackingArea];
}

- (void)removeTrackingArea {
  [_zenViewWithTrackingArea removeTrackingArea:_zenTrackingArea];
  [_zenTrackingArea release];
  _zenTrackingArea = nil;
  [_zenViewWithTrackingArea release];
  _zenViewWithTrackingArea = nil;
}

- (void)mouseEntered:(NSEvent*)aEvent {
  ZenWindowMouseEntered(aEvent);
}

- (void)mouseExited:(NSEvent*)aEvent {
  ZenWindowMouseExited(aEvent);
}

- (void)mouseMoved:(NSEvent*)aEvent {
  ZenWindowMouseMoved(aEvent);
}

- (void)cursorUpdated:(NSEvent*)aEvent {
}

- (NSMutableDictionary*)exportState {
  return [[@{
    @"title" : self.title ?: @"",
    @"drawsContentsIntoWindowFrame" : @(_zenDrawsIntoWindowFrame),
    @"collectionBehavior" : @(self.collectionBehavior),
  } mutableCopy] autorelease];
}

- (void)importState:(NSDictionary*)aState {
  if (NSString* title = aState[@"title"]) {
    self.title = title;
  }
  [self setDrawsContentsIntoWindowFrame:
            [aState[@"drawsContentsIntoWindowFrame"] boolValue]];
  if (NSNumber* behavior = aState[@"collectionBehavior"]) {
    self.collectionBehavior = behavior.unsignedIntegerValue;
  }
}

- (void)setEffectViewWrapperForStyle:(mozilla::WindowShadow)aStyle {
  _zenShadowStyle = aStyle;
}

- (void)setShadowStyle:(mozilla::WindowShadow)aStyle {
  _zenShadowStyle = aStyle;
}

- (mozilla::WindowShadow)shadowStyle {
  return _zenShadowStyle;
}

- (void)updateTitlebarTransparency {
  self.titlebarAppearsTransparent = _zenDrawsIntoWindowFrame;
}

- (void)releaseJSObjects {
}

- (void)placeWindowButtons:(NSRect)aRect {
  if (!NSEqualRects(_zenWindowButtonsRect, aRect)) {
    _zenWindowButtonsRect = aRect;
    NSView* frameView = self.contentView.superview;
    if ([frameView respondsToSelector:@selector(_tileTitlebarAndRedisplay:)]) {
      [frameView _tileTitlebarAndRedisplay:NO];
    }
  }
}

- (NSRect)windowButtonsRect {
  return _zenWindowButtonsRect;
}

- (void)windowMainStateChanged {
  self.contentView.needsDisplay = YES;
}

- (BOOL)respondsToSelector:(SEL)aSelector {
  if (aSelector == @selector(cancelOperation:)) {
    return NO;
  }
  return [super respondsToSelector:aSelector];
}

- (void)doCommandBySelector:(SEL)aSelector {
  [self tryToPerform:aSelector with:nil];
}

- (NSRect)getAndResetNativeDirtyRect {
  return NSZeroRect;
}

- (BOOL)performKeyEquivalent:(NSEvent*)aEvent {
  NSWindow* retainedWindow = [self retain];
  BOOL handled = [super performKeyEquivalent:aEvent];
  [retainedWindow release];
  return handled;
}

- (void)dealloc {
  ZenWindowDestroyed(self);
  [super dealloc];
}

@end

static NSInteger sVisibleSearchPanel = -1;

static constexpr char kSearchLeft[] = "zen.global-search.position.left";
static constexpr char kSearchTop[] = "zen.global-search.position.top";
static constexpr char kSearchDisplay[] = "zen.global-search.position.display";

@implementation ZenSearchPanel
- (void)rememberPosition:(NSNotification*)notification {
  if (!self.screen || self.windowNumber != sVisibleSearchPanel) {
    return;
  }
  NSRect bounds = self.screen.visibleFrame;
  mozilla::Preferences::SetInt(kSearchLeft, lround(NSMinX(self.frame) - NSMinX(bounds)));
  mozilla::Preferences::SetInt(kSearchTop, lround(NSMaxY(bounds) - NSMaxY(self.frame)));
  mozilla::Preferences::SetUint(kSearchDisplay, [self.screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue]);
}
- (void)resignKeyWindow {
  [super resignKeyWindow];
  NSInteger number = self.windowNumber;
  NS_DispatchToMainThread(NS_NewRunnableFunction("ZenSearchResigned", [number] {
    if (sVisibleSearchPanel == number && ![NSApp windowWithWindowNumber:number].keyWindow) {
      sVisibleSearchPanel = -1;
      if (nsCOMPtr<nsIObserverService> observers = mozilla::services::GetObserverService()) {
        observers->NotifyObservers(nullptr, "zen-global-search-dismiss", nullptr);
      }
    }
  }));
}
- (void)close {
  [NSNotificationCenter.defaultCenter removeObserver:self name:NSWindowDidMoveNotification object:self];
  if (sVisibleSearchPanel == self.windowNumber) {
    sVisibleSearchPanel = -1;
  }
  [super close];
}
- (BOOL)canBecomeMainWindow { return NO; }
- (void)setOpaque:(BOOL)opaque { [super setOpaque:NO]; }
- (NSAccessibilityRole)accessibilityRole { return NSAccessibilityPopoverRole; }
- (NSAccessibilitySubrole)accessibilitySubrole { return NSAccessibilityUnknownSubrole; }
@end

static NSWindow* NativeWindow(nsIBaseWindow* aWindow) {
  if (!aWindow) {
    return nil;
  }
  nsCOMPtr<nsIWidget> widget = aWindow->GetMainWidget();
  return widget
             ? static_cast<NSWindow*>(widget->GetNativeData(NS_NATIVE_WINDOW))
             : nil;
}

// Called synchronously by nsCocoaWindow::CreateNativeWindow. Preparation is
// one-shot so no unrelated browser window can inherit the panel class.
Class ZenConsumePreparedPanelClass() {
  ZenPreparedPanelKind preparedKind = sPreparedPanelKind;
  sPreparedPanelKind = ZenPreparedPanelKind::None;
  if (preparedKind == ZenPreparedPanelKind::Search) {
    return [ZenSearchPanel class];
  }
  return preparedKind == ZenPreparedPanelKind::Standalone
             ? [ZenStandalonePanel class]
             : Nil;
}

namespace zen {

void ZenCommonUtils::PrepareStandalonePanelInternal() {
  MOZ_ASSERT(NS_IsMainThread());
  sPreparedPanelKind = ZenPreparedPanelKind::Standalone;
}

void ZenCommonUtils::CancelPreparedStandalonePanelInternal() {
  MOZ_ASSERT(NS_IsMainThread());
  sPreparedPanelKind = ZenPreparedPanelKind::None;
}

bool ZenCommonUtils::IsStandalonePanelInternal(nsIBaseWindow* aWindow) {
  return ZenWindowActsAsMain(NativeWindow(aWindow));
}

NS_IMETHODIMP ZenCommonUtils::PrepareSearchPanel() {
  sPreparedPanelKind = ZenPreparedPanelKind::Search;
  return NS_OK;
}

NS_IMETHODIMP ZenCommonUtils::ShowSearchPanel(nsIBaseWindow* base) {
  NSWindow* panel = NativeWindow(base);
  if (![panel isKindOfClass:[ZenSearchPanel class]]) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  nsCOMPtr<nsIWidget> widget = base->GetMainWidget();
  widget->SetTransparencyMode(mozilla::widget::TransparencyMode::Transparent);
  NSScreen* screen = NSScreen.mainScreen;
  for (NSScreen* candidate in NSScreen.screens) {
    if (NSMouseInRect(NSEvent.mouseLocation, candidate.frame, NO)) {
      screen = candidate;
      break;
    }
  }
  uint32_t display = mozilla::Preferences::GetUint(kSearchDisplay);
  for (NSScreen* candidate in NSScreen.screens) {
    if ([candidate.deviceDescription[@"NSScreenNumber"] unsignedIntValue] == display) {
      screen = candidate;
      break;
    }
  }
  NSRect bounds = screen.visibleFrame;
  NSSize size = NSMakeSize(MIN(680, bounds.size.width), MIN(480, bounds.size.height));
  // Keep the input anchored while the results grow underneath it.
  CGFloat top = NSMaxY(bounds) - MIN(bounds.size.height / 4, bounds.size.height - size.height);
  CGFloat left = NSMidX(bounds) - size.width / 2;
  if (display) {
    left = NSMinX(bounds) + std::clamp<CGFloat>(mozilla::Preferences::GetInt(kSearchLeft), 0, bounds.size.width - size.width);
    top = NSMaxY(bounds) - std::clamp<CGFloat>(mozilla::Preferences::GetInt(kSearchTop), 0, bounds.size.height - size.height);
  }
  panel.level = NSFloatingWindowLevel;
  panel.backgroundColor = NSColor.clearColor;
  panel.hasShadow = NO;
  panel.contentMinSize = NSMakeSize(1, 1);
  [panel setFrame:NSMakeRect(left, top - size.height,
                             size.width, size.height) display:YES];
  [NSApp removeWindowsItem:panel];
  [panel orderFrontRegardless];
  [panel makeKeyWindow];
  sVisibleSearchPanel = panel.windowNumber;
  [NSNotificationCenter.defaultCenter addObserver:panel selector:@selector(rememberPosition:)
                                             name:NSWindowDidMoveNotification object:panel];
  return NS_OK;
}

static EventHotKeyRef sHotkey;
static EventHandlerRef sHandler;
static UInt32 sHotkeyId;

static OSStatus SearchHotkeyPressed(EventHandlerCallRef, EventRef event, void*) {
  EventHotKeyID id{};
  if (GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID,
                        nullptr, sizeof(id), nullptr, &id) != noErr ||
      id.signature != 'ZenS' || !sHotkey || id.id != sHotkeyId) {
    return eventNotHandledErr;
  }
  NS_DispatchToMainThread(NS_NewRunnableFunction("ZenSearchShortcut", [] {
    if (nsCOMPtr<nsIObserverService> observers = mozilla::services::GetObserverService()) {
      observers->NotifyObservers(nullptr, "zen-global-search", nullptr);
    }
  }));
  return noErr;
}

NS_IMETHODIMP ZenCommonUtils::SetSearchHotkey(const nsACString& code,
                                              uint16_t modifiers, bool* result) {
  *result = false;
  if (!(modifiers & 7) || modifiers > 15) {
    return NS_OK;
  }
  static const struct { const char* code; UInt32 key; } keys[] = {
    {"KeyA", kVK_ANSI_A},
    {"KeyB", kVK_ANSI_B},
    {"KeyC", kVK_ANSI_C},
    {"KeyD", kVK_ANSI_D},
    {"KeyE", kVK_ANSI_E},
    {"KeyF", kVK_ANSI_F},
    {"KeyG", kVK_ANSI_G},
    {"KeyH", kVK_ANSI_H},
    {"KeyI", kVK_ANSI_I},
    {"KeyJ", kVK_ANSI_J},
    {"KeyK", kVK_ANSI_K},
    {"KeyL", kVK_ANSI_L},
    {"KeyM", kVK_ANSI_M},
    {"KeyN", kVK_ANSI_N},
    {"KeyO", kVK_ANSI_O},
    {"KeyP", kVK_ANSI_P},
    {"KeyQ", kVK_ANSI_Q},
    {"KeyR", kVK_ANSI_R},
    {"KeyS", kVK_ANSI_S},
    {"KeyT", kVK_ANSI_T},
    {"KeyU", kVK_ANSI_U},
    {"KeyV", kVK_ANSI_V},
    {"KeyW", kVK_ANSI_W},
    {"KeyX", kVK_ANSI_X},
    {"KeyY", kVK_ANSI_Y},
    {"KeyZ", kVK_ANSI_Z},
    {"Digit0", kVK_ANSI_0},
    {"Digit1", kVK_ANSI_1},
    {"Digit2", kVK_ANSI_2},
    {"Digit3", kVK_ANSI_3},
    {"Digit4", kVK_ANSI_4},
    {"Digit5", kVK_ANSI_5},
    {"Digit6", kVK_ANSI_6},
    {"Digit7", kVK_ANSI_7},
    {"Digit8", kVK_ANSI_8},
    {"Digit9", kVK_ANSI_9},
    {"F1", kVK_F1},
    {"F2", kVK_F2},
    {"F3", kVK_F3},
    {"F4", kVK_F4},
    {"F5", kVK_F5},
    {"F6", kVK_F6},
    {"F7", kVK_F7},
    {"F8", kVK_F8},
    {"F9", kVK_F9},
    {"F10", kVK_F10},
    {"F11", kVK_F11},
    {"F12", kVK_F12},
    {"F13", kVK_F13},
    {"F14", kVK_F14},
    {"F15", kVK_F15},
    {"F16", kVK_F16},
    {"F17", kVK_F17},
    {"F18", kVK_F18},
    {"F19", kVK_F19},
    {"F20", kVK_F20},
  };
  for (const auto& entry : keys) {
    if (!code.Equals(entry.code)) {
      continue;
    }
    if (!sHandler) {
      EventTypeSpec press = {kEventClassKeyboard, kEventHotKeyPressed};
      if (InstallApplicationEventHandler(SearchHotkeyPressed, 1, &press,
                                         nullptr, &sHandler) != noErr) {
        return NS_OK;
      }
    }
    UInt32 flags = ((modifiers & 1) ? controlKey : 0) |
                   ((modifiers & 2) ? cmdKey : 0) |
                   ((modifiers & 4) ? optionKey : 0) |
                   ((modifiers & 8) ? shiftKey : 0);
    EventHotKeyRef replacement;
    EventHotKeyID id = {'ZenS', sHotkeyId + 1};
    if (RegisterEventHotKey(entry.key, flags, id, GetApplicationEventTarget(),
                            0, &replacement) == noErr) {
      if (sHotkey) {
        UnregisterEventHotKey(sHotkey);
      }
      sHotkey = replacement;
      sHotkeyId = id.id;
      *result = true;
    }
    break;
  }
  return NS_OK;
}

NS_IMETHODIMP ZenCommonUtils::ClearSearchHotkey() {
  if (sHotkey) {
    UnregisterEventHotKey(sHotkey);
    sHotkey = nullptr;
  }
  if (sHandler) {
    RemoveEventHandler(sHandler);
    sHandler = nullptr;
  }
  return NS_OK;
}

}  // namespace zen

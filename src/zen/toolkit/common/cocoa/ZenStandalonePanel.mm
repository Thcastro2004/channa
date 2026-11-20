/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ZenCommonUtils.h"

#include "nsIBaseWindow.h"
#include "nsIWidget.h"
#include "nsThreadUtils.h"

#include <cstdint>

#import <AppKit/AppKit.h>

enum class ZenPreparedPanelKind : uint8_t {
  None,
  Standalone,
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

bool ZenWindowActsAsMain(NSWindow* aWindow) {
  return [aWindow isKindOfClass:[ZenStandalonePanel class]];
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
  self = [super initWithContentRect:aContentRect
                          styleMask:style
                            backing:aBackingType
                              defer:aFlag];
  if (self) {
    self.floatingPanel = NO;
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
               NSWindowCollectionBehaviorFullScreenDisallowsTiling |
               NSWindowCollectionBehaviorParticipatesInCycle;
  [super setCollectionBehavior:aBehavior];
}

- (void)makeKeyAndOrderFront:(id)aSender {
  [super makeKeyAndOrderFront:aSender];
  if (!NSApp.active && self.keyWindow) {
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
  if (sPreparedPanelKind == ZenPreparedPanelKind::Standalone) {
    sPreparedPanelKind = ZenPreparedPanelKind::None;
  }
}

bool ZenCommonUtils::IsStandalonePanelInternal(nsIBaseWindow* aWindow) {
  return [NativeWindow(aWindow) isKindOfClass:[ZenStandalonePanel class]];
}

}  // namespace zen

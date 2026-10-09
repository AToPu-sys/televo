import AVKit
import ExpoModulesCore
import React
import UIKit
// react-native-webrtc's pod generates a real Clang module (its umbrella
// header includes WebRTCModule.h) — no bridging header needed. See
// ExpoCallPip.podspec's own comment for why a bridging header doesn't work
// here (Expo modules always build as framework targets).
import react_native_webrtc

/// System-level Picture-in-Picture for an active video call, using
/// AVPictureInPictureVideoCallViewController (the "video call" flavor of
/// PiP, distinct from the AVPlayerLayer/media-playback flavor) — keeps the
/// peer's video floating above the home screen/other apps when Televo is
/// backgrounded during a call, instead of the camera freezing and the call
/// breaking (the bug this exists to fix).
///
/// `canStartPictureInPictureAutomaticallyFromInline = true` is what makes
/// this work without any AppState/applicationDidEnterBackground wiring on
/// the JS side: once the controller is armed (startSession has been
/// called), iOS itself starts PiP the moment the app backgrounds — this
/// module only needs to be armed while a call is live and disarmed when it
/// ends, not told WHEN to actually show PiP.
public class CallPipModule: Module {
  /// Whether iOS will keep the camera running while the app is in PiP. A
  /// property of the app's entitlements, not of any one session, so a
  /// throwaway session answers it once.
  static let backgroundCameraSupported: Bool = {
    if #available(iOS 16.0, *) {
      return AVCaptureSession().isMultitaskingCameraAccessSupported
    }
    return false
  }()

  private var pipController: AVPictureInPictureController?
  private var pipViewController: CallPipViewController?
  private var sourceView: UIView?
  private var activeVideoTrack: RTCVideoTrack?
  private var activeSelfVideoTrack: RTCVideoTrack?

  public func definition() -> ModuleDefinition {
    Name("CallPip")

    Events("onPipWillStart", "onPipDidStop", "onPipFailedToStart")

    // Must run before the first getUserMedia: react-native-webrtc reads this
    // option when it builds the capture session (WebRTCModule+RTCMediaStream
    // → VideoCaptureController). It was never set, so iOS paused this
    // device's camera the moment the app went to PiP and the peer saw a
    // frozen frame. iOS only honours it when the session reports
    // isMultitaskingCameraAccessSupported (on iPhone that needs Apple's
    // multitasking-camera-access entitlement); otherwise it's a no-op and
    // useCall falls back to telling the peer the camera is paused.
    OnCreate {
      WebRTCModuleOptions.sharedInstance().enableMultitaskingCameraAccess = true
    }

    Function("isSupported") { () -> Bool in
      AVPictureInPictureController.isPictureInPictureSupported()
    }

    Function("isBackgroundCameraSupported") { () -> Bool in
      CallPipModule.backgroundCameraSupported
    }

    // Called once a video call's remote track is actually flowing (see
    // useCallManager.tsx — the same "media-flowing" signal WebRtcBridge
    // already tracks for mediaConfirmed) — NOT on backgrounding itself.
    // The controller must be armed BEFORE the app backgrounds for iOS's
    // automatic-start behavior above to have anything to trigger.
    Function("startSession") { (streamReactTag: String, localStreamReactTag: String?) in
      DispatchQueue.main.async { [weak self] in
        self?.startSession(streamReactTag: streamReactTag, localStreamReactTag: localStreamReactTag)
      }
    }

    // Called at the same point WebRtcBridge's own releaseMedia() runs
    // (call ended/hung up) — tears down the controller and frame relay so
    // a finished call never leaves a stale PiP source registered, and so
    // the RTCVideoRenderer isn't left attached to a track that's about to
    // be disposed.
    Function("endSession") {
      DispatchQueue.main.async { [weak self] in
        self?.endSession()
      }
    }

    OnDestroy {
      DispatchQueue.main.async { [weak self] in
        self?.endSession()
      }
    }
  }

  private func startSession(streamReactTag: String, localStreamReactTag: String?) {
    guard AVPictureInPictureController.isPictureInPictureSupported() else { return }

    // Ending any previous session first — startSession can legitimately be
    // called again for a NEW call (e.g. hang up, immediately call again)
    // before this module has otherwise heard the old one end.
    endSession()

    guard let bridge = appContext?.reactBridge,
      let webRTCModule = bridge.module(forName: "WebRTCModule") as? WebRTCModule,
      let stream = webRTCModule.stream(forReactTag: streamReactTag),
      let videoTrack = stream.videoTracks.first
    else {
      sendEvent("onPipFailedToStart", ["reason": "no video track"])
      return
    }

    let pipVC = CallPipViewController()
    videoTrack.add(pipVC.frameRelay)
    pipViewController = pipVC
    activeVideoTrack = videoTrack

    // Self thumbnail (FaceTime-style small corner overlay) — best-effort:
    // a missing/unresolvable local stream just means PiP shows the peer
    // full-size with no self view, not a failure worth sendEvent'ing.
    if let localStreamReactTag,
      let localStream = webRTCModule.stream(forReactTag: localStreamReactTag),
      let localVideoTrack = localStream.videoTracks.first
    {
      localVideoTrack.add(pipVC.selfFrameRelay)
      activeSelfVideoTrack = localVideoTrack
    }

    // The anchor view for PiP's fly-out/fly-back animation — never itself
    // the thing PiP shows (that's pipVC.view, hosting the
    // AVSampleBufferDisplayLayer the frame relay feeds), but it DOES have to
    // be a real subview of the key window, not a detached UIView(frame:
    // .zero). `canStartPictureInPictureAutomaticallyFromInline` makes iOS
    // auto-start PiP on backgrounding only when it considers the content
    // source "inline" — i.e. actually part of the visible window hierarchy
    // right now. A detached anchor reports sourceIsVisible == NO and
    // isFullScreen == NO to AVKit regardless of what CallOverlay.tsx's own
    // minimized/full-screen state is showing in React Native, since AVKit
    // has no visibility into RN's own layer at all — it only ever looks at
    // THIS anchor. Confirmed via a real device's AVKit log
    // (2026-10-03, rootkali): "isFullScreen - NO ... sourceIsVisible: NO ...
    // pictureInPictureShouldStartWhenEnteringBackground NO" — PiP was being
    // refused on every backgrounding, minimized or not, because the anchor
    // was never attached anywhere. 1x1 and alpha 0.01 (not 0 — a fully
    // transparent/zero-alpha view can still be treated as not visible by
    // some AVKit checks) keeps it imperceptible without disqualifying it.
    let anchor = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
    anchor.alpha = 0.01
    anchor.isUserInteractionEnabled = false
    if let window = UIApplication.shared.connectedScenes
      .compactMap({ ($0 as? UIWindowScene)?.keyWindow })
      .first ?? UIApplication.shared.windows.first
    {
      window.addSubview(anchor)
    }
    sourceView = anchor

    let contentSource = AVPictureInPictureController.ContentSource(
      activeVideoCallSourceView: anchor,
      contentViewController: pipVC
    )
    let controller = AVPictureInPictureController(contentSource: contentSource)
    controller.canStartPictureInPictureAutomaticallyFromInline = true
    pipController = controller
  }

  private func endSession() {
    pipController?.stopPictureInPicture()
    pipController = nil
    if let pipViewController, let activeVideoTrack {
      activeVideoTrack.remove(pipViewController.frameRelay)
    }
    if let pipViewController, let activeSelfVideoTrack {
      activeSelfVideoTrack.remove(pipViewController.selfFrameRelay)
    }
    pipViewController = nil
    activeVideoTrack = nil
    activeSelfVideoTrack = nil
    // Now a real window subview (see startSession) — must be explicitly
    // removed, or every call leaks one more 1x1 view into the window.
    sourceView?.removeFromSuperview()
    sourceView = nil
  }
}

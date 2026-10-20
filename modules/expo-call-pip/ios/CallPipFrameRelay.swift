import WebRTC
import AVFoundation
import VideoToolbox

/// Bridges a live WebRTC remote video track's decoded frames into an
/// `AVSampleBufferDisplayLayer` — the one surface type Apple's system
/// Picture-in-Picture (`AVPictureInPictureVideoCallViewController`) can
/// actually composite while the app is backgrounded.
///
/// This exists because `react-native-webrtc`'s own `RTCView` renders through
/// `RTCMTLVideoView` (Metal/`MTKView`), which system PiP does not reliably
/// draw once the app is suspended in the background — every WebRTC-based
/// video-call SDK that supports PiP (Zoom, 100ms, etc.) works around this
/// the same way: attach a SEPARATE `RTCVideoRenderer` directly to the track
/// and feed its raw frames into an `AVSampleBufferDisplayLayer`-backed view
/// instead of reusing the Metal view. The Metal-rendered `RTCView` stays
/// exactly as it is for the in-app UI; this is an entirely parallel path
/// that only exists for the PiP window.
final class CallPipFrameRelay: NSObject, RTCVideoRenderer {
  let displayLayer = AVSampleBufferDisplayLayer()
  private var formatDescription: CMFormatDescription?
  private var lastPixelBufferSize: (width: Int32, height: Int32) = (0, 0)

  /// Called on the main queue whenever the frame's rotation or upright size
  /// changes. Camera buffers arrive in the sensor's landscape orientation
  /// with a separate `rotation` tag (RTCMTLVideoView applies it for the
  /// in-app view); AVSampleBufferDisplayLayer ignores it, so without this the
  /// PiP window showed every face lying on its side inside a landscape box.
  ///
  /// 2026-10-17: on iOS 16+ the rotation is now applied to the PIXELS
  /// (VTPixelRotationSession, hardware) before the frame is enqueued, and the
  /// callback reports 0 so the layer itself is never transformed. Turning
  /// the layer with an affine transform was not honoured inside the system
  /// PiP window on current iOS — both videos showed up lying on their side
  /// even though the in-app view was upright. iOS 15 keeps the transform.
  var onGeometryChange: ((_ rotationDegrees: Int, _ uprightSize: CGSize) -> Void)?
  private var lastRotation = -1
  private var lastUprightSize = CGSize.zero
  // VTPixelRotationSession (iOS 16+). Stored untyped because a stored
  // property can't be @available-gated and the module targets iOS 15.1.
  private var rotationSessionStorage: AnyObject?
  private var rotationSessionDegrees = -1
  private var rotatedPool: CVPixelBufferPool?
  private var rotatedPoolKey = ""

  func setSize(_ size: CGSize) {
    // No-op: AVSampleBufferDisplayLayer sizes itself from each sample
    // buffer's own format description, not from an out-of-band size hint —
    // unlike RTCMTLVideoView, which DOES use this callback to lay out its
    // Metal surface.
  }

  func renderFrame(_ frame: RTCVideoFrame?) {
    guard let frame else { return }
    // Frames decoded in hardware (the common case on a real device) arrive
    // as RTCCVPixelBuffer, which wraps a CVPixelBuffer directly — no CPU
    // colorspace conversion needed to reach AVSampleBufferDisplayLayer,
    // which also wants a CVPixelBuffer-backed CMSampleBuffer. A frame that
    // arrives as some OTHER RTCVideoFrameBuffer implementation (software
    // decode/I420 path) is dropped here rather than converted — PiP losing
    // a frame occasionally is fine, the in-app RTCView (Metal, handles I420
    // itself) remains the primary rendering path throughout.
    guard let pixelBufferFrame = frame.buffer as? RTCCVPixelBuffer else { return }
    let sourceBuffer = pixelBufferFrame.pixelBuffer

    let sourceWidth = Int32(CVPixelBufferGetWidth(sourceBuffer))
    let sourceHeight = Int32(CVPixelBufferGetHeight(sourceBuffer))

    let rotation = frame.rotation.rawValue
    let quarterTurn = rotation == 90 || rotation == 270
    let uprightSize = quarterTurn
      ? CGSize(width: CGFloat(sourceHeight), height: CGFloat(sourceWidth))
      : CGSize(width: CGFloat(sourceWidth), height: CGFloat(sourceHeight))

    // Upright pixels where the OS can do it; otherwise the original buffer
    // plus a layer transform (the reported rotation) as before.
    var pixelBuffer = sourceBuffer
    var layerRotation = rotation
    if rotation != 0, #available(iOS 16.0, *), let upright = rotateUpright(sourceBuffer, degrees: rotation, size: uprightSize) {
      pixelBuffer = upright
      layerRotation = 0
    }

    if layerRotation != lastRotation || uprightSize != lastUprightSize {
      lastRotation = layerRotation
      lastUprightSize = uprightSize
      let callback = onGeometryChange
      DispatchQueue.main.async { callback?(layerRotation, uprightSize) }
    }

    let width = Int32(CVPixelBufferGetWidth(pixelBuffer))
    let height = Int32(CVPixelBufferGetHeight(pixelBuffer))
    if formatDescription == nil || width != lastPixelBufferSize.width || height != lastPixelBufferSize.height {
      var newFormatDescription: CMFormatDescription?
      let status = CMVideoFormatDescriptionCreateForImageBuffer(
        allocator: kCFAllocatorDefault,
        imageBuffer: pixelBuffer,
        formatDescriptionOut: &newFormatDescription
      )
      guard status == noErr, let newFormatDescription else { return }
      formatDescription = newFormatDescription
      lastPixelBufferSize = (width, height)
    }
    guard let formatDescription else { return }

    var timingInfo = CMSampleTimingInfo(
      duration: .invalid,
      presentationTimeStamp: CMTime(value: frame.timeStampNs, timescale: 1_000_000_000),
      decodeTimeStamp: .invalid
    )

    var sampleBuffer: CMSampleBuffer?
    let status = CMSampleBufferCreateForImageBuffer(
      allocator: kCFAllocatorDefault,
      imageBuffer: pixelBuffer,
      dataReady: true,
      makeDataReadyCallback: nil,
      refcon: nil,
      formatDescription: formatDescription,
      sampleTiming: &timingInfo,
      sampleBufferOut: &sampleBuffer
    )
    guard status == noErr, let sampleBuffer else { return }

    // A layer left in a failed state (e.g. the app was suspended mid-frame)
    // silently stops accepting new samples forever — matches a known rough
    // edge on recent iOS versions where a PiP AVSampleBufferDisplayLayer can
    // wedge despite frames still arriving. Flushing on failure is cheap
    // insurance against that.
    if displayLayer.status == .failed {
      displayLayer.flush()
    }
    if displayLayer.isReadyForMoreMediaData {
      displayLayer.enqueue(sampleBuffer)
    }
  }

  /// Rotates a camera/decoder buffer into an upright, IOSurface-backed copy
  /// (what AVSampleBufferDisplayLayer wants) on VideoToolbox's hardware path.
  /// nil on any failure — the caller then falls back to the layer transform.
  @available(iOS 16.0, *)
  private func rotateUpright(_ source: CVPixelBuffer, degrees: Int, size: CGSize) -> CVPixelBuffer? {
    if rotationSessionStorage == nil || rotationSessionDegrees != degrees {
      if let old = rotationSessionStorage { VTPixelRotationSessionInvalidate(old as! VTPixelRotationSession) }
      rotationSessionStorage = nil
      var session: VTPixelRotationSession?
      guard VTPixelRotationSessionCreate(kCFAllocatorDefault, &session) == noErr,
            let session else { return nil }
      let angle: CFString
      switch degrees {
      case 90: angle = kVTRotation_CW90
      case 180: angle = kVTRotation_180
      case 270: angle = kVTRotation_CCW90
      default: angle = kVTRotation_0
      }
      VTSessionSetProperty(session, key: kVTPixelRotationPropertyKey_Rotation, value: angle)
      rotationSessionStorage = session
      rotationSessionDegrees = degrees
    }
    guard let stored = rotationSessionStorage else { return nil }
    let session = stored as! VTPixelRotationSession

    let format = CVPixelBufferGetPixelFormatType(source)
    let width = Int(size.width), height = Int(size.height)
    let key = "\(format)-\(width)x\(height)"
    if rotatedPool == nil || rotatedPoolKey != key {
      let attributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: format,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
      ]
      var pool: CVPixelBufferPool?
      guard CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &pool) == kCVReturnSuccess,
            let pool else { return nil }
      rotatedPool = pool
      rotatedPoolKey = key
    }
    guard let pool = rotatedPool else { return nil }
    var output: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &output) == kCVReturnSuccess, let output else {
      return nil
    }
    guard VTPixelRotationSessionRotateImage(session, source, output) == noErr else {
      return nil
    }
    return output
  }
}

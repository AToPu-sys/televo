import UIKit
import AVKit

/// The view controller Apple's system PiP actually shows. Hosts TWO
/// AVSampleBufferDisplayLayers, matching FaceTime's own PiP layout: the
/// peer's video fills the whole PiP window, and this device's own camera
/// floats as a small rounded thumbnail in the bottom-right corner on top of
/// it — both people visible, not just the peer. The local thumbnail is
/// optional (selfFrameRelay is only attached when a local stream exists —
/// see CallPipModule.startSession); its layer is simply left empty if there
/// is nothing feeding it.
final class CallPipViewController: AVPictureInPictureVideoCallViewController {
  let frameRelay = CallPipFrameRelay()
  let selfFrameRelay = CallPipFrameRelay()

  private let selfThumbnailMargin: CGFloat = 8
  private let selfThumbnailWidthFraction: CGFloat = 0.3
  private var peerRotation = 0
  private var selfRotation = 0

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    frameRelay.displayLayer.videoGravity = .resizeAspect
    view.layer.addSublayer(frameRelay.displayLayer)

    // On top of the peer layer, in z-order — added after, so it paints
    // above. resizeAspectFill matches how the in-app self preview crops to
    // fill its small corner box, rather than letterboxing.
    selfFrameRelay.displayLayer.videoGravity = .resizeAspectFill
    selfFrameRelay.displayLayer.cornerRadius = 8
    selfFrameRelay.displayLayer.masksToBounds = true
    selfFrameRelay.displayLayer.borderWidth = 1
    selfFrameRelay.displayLayer.borderColor = UIColor.white.withAlphaComponent(0.6).cgColor
    view.layer.addSublayer(selfFrameRelay.displayLayer)

    frameRelay.onGeometryChange = { [weak self] rotation, uprightSize in
      guard let self else { return }
      self.peerRotation = rotation
      // Sizes the PiP window itself to the peer's upright video — a
      // portrait phone camera gets a portrait window instead of a
      // landscape one with black bars above and below.
      if uprightSize.width > 0, uprightSize.height > 0 {
        self.preferredContentSize = uprightSize
      }
      self.view.setNeedsLayout()
    }
    selfFrameRelay.onGeometryChange = { [weak self] rotation, _ in
      self?.selfRotation = rotation
      self?.view.setNeedsLayout()
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    place(frameRelay.displayLayer, in: view.bounds, rotation: peerRotation)

    let width = view.bounds.width * selfThumbnailWidthFraction
    // Fixed 3:4 portrait box, close to the in-app self-preview corner box.
    let height = width * (4.0 / 3.0)
    let thumbnail = CGRect(
      x: view.bounds.width - width - selfThumbnailMargin,
      y: view.bounds.height - height - selfThumbnailMargin,
      width: width,
      height: height
    )
    place(selfFrameRelay.displayLayer, in: thumbnail, rotation: selfRotation)
  }

  /// Lays a layer out to fill `rect` once rotated by `rotation` degrees
  /// clockwise (WebRTC's convention, same as UIKit's positive angle). The
  /// layer's own bounds are swapped for quarter turns so that AFTER rotation
  /// it covers `rect` exactly. `frame` can't be used here — it's undefined on
  /// a layer with a non-identity transform.
  private func place(_ layer: CALayer, in rect: CGRect, rotation: Int) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let quarterTurn = rotation == 90 || rotation == 270
    layer.setAffineTransform(.identity)
    layer.bounds = CGRect(
      x: 0,
      y: 0,
      width: quarterTurn ? rect.height : rect.width,
      height: quarterTurn ? rect.width : rect.height
    )
    layer.position = CGPoint(x: rect.midX, y: rect.midY)
    layer.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(rotation) * .pi / 180))
    CATransaction.commit()
  }
}
